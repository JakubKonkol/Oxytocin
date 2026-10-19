import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const HOOK_PATH = '/task/exit-plan';
/** Set in the planner's terminal only: the task whose plan the hook hands over. */
export const TASK_VAR = 'OXYTOCIN_TASK_ID';
export const MAX_BODY_BYTES = 1024 * 1024;

/** What Claude reads when the hook takes its plan instead of asking the user in the terminal. */
export const HANDED_OVER_REASON =
  'The plan was handed to Oxytocin for approval. Stop here: do not implement anything and do not call ExitPlanMode ' +
  'again. If you receive feedback, revise the plan and finish it again with ExitPlanMode.';

/** Git commands a planning session must not run even with bypass permissions available. */
const GIT_DENY = ['commit', 'push', 'checkout', 'reset'].map((command) => `Bash(git ${command} *)`);

/**
 * A path as Claude Code's permission rules spell an absolute path: `//` + the POSIX form (Windows drive paths are
 * normalized to `/c/Users/...` before matching).
 */
export function absoluteRulePath(path: string): string {
  const windows = /^([A-Za-z]):[\\/]*(.*)$/.exec(path);
  const posix = windows ? `/${windows[1]!.toLowerCase()}/${windows[2]!.replace(/\\/g, '/')}` : path;
  return `/${posix.replace(/\/+$/, '')}`;
}

/**
 * The `--settings` file of a planning session (it only adds to the user's and the project's settings):
 * - a `PreToolUse` hook on `ExitPlanMode` that hands the finished plan to Task over HTTP. An `http` hook needs no shell
 *   (no bash, jq or PowerShell on Windows); Claude Code interpolates the task id from the terminal's environment.
 *   Outside a Task terminal the id is empty and Task answers "no decision"; when Oxytocin does not answer, the request
 *   fails as a non-blocking hook error and Claude Code asks in the terminal as usual, so the plan is never lost.
 * - deny rules: with bypass permissions available Claude Code does not enforce plan mode's blocks in an interactive
 *   terminal, so edits inside the project and git commands that change history or the working tree are denied.
 *   Claude Code writes its plan file outside the project (`~/.claude/plans/` or `plansDirectory`).
 */
export function plannerSettings(o: { projectRoot: string; url: string; token: string }) {
  return {
    permissions: { deny: [`Edit(${absoluteRulePath(o.projectRoot)}/**)`, ...GIT_DENY] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'ExitPlanMode',
          hooks: [
            {
              type: 'http',
              url: o.url,
              timeout: 10,
              headers: { Authorization: `Bearer ${o.token}`, 'X-Oxytocin-Task': `$${TASK_VAR}` },
              allowedEnvVars: [TASK_VAR],
            },
          ],
        },
      ],
    },
  };
}

/** Claude Code's `PreToolUse` input for `ExitPlanMode`: the plan and its file are injected by Claude Code. */
export const ExitPlanInputSchema = z.object({
  session_id: z.string().max(200).optional(),
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.literal('ExitPlanMode'),
  tool_input: z.object({ plan: z.string(), planFilePath: z.string().max(4096).optional() }).passthrough(),
});
export type ExitPlanInput = z.infer<typeof ExitPlanInputSchema>;

/** The hook's answer: the plan was taken, Claude stops instead of asking the user in the terminal. */
export const handedOver = () => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: HANDED_OVER_REASON,
  },
});

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * 127.0.0.1 only, Bearer token, JSON up to 1 MB. The handler's object is the hook's JSON output; `undefined` answers
 * 204, which Claude Code reads as "no decision" (its usual approval question follows).
 */
export class PlanHookServer {
  private server: Server | undefined;

  constructor(
    private readonly token: string,
    private readonly onPlan: (taskId: string, input: ExitPlanInput) => Promise<object | undefined>,
  ) {}

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  /** Listens on `port`, or on any free port when it is taken. */
  async start(port: number): Promise<number> {
    await this.stop();
    const listen = (p: number) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => void this.handle(req, res));
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => resolve(server));
      });
    this.server = await listen(port).catch(() => listen(0));
    return this.port!;
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private reply(res: ServerResponse, status: number, body?: object): void {
    if (!body) {
      res.writeHead(status);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) return this.reply(res, 404);
    if (!sameSecret(String(req.headers['authorization'] ?? ''), `Bearer ${this.token}`)) return this.reply(res, 401);
    const taskId = String(req.headers['x-oxytocin-task'] ?? '');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return this.reply(res, 413);
        chunks.push(chunk as Buffer);
      }
      // Not a Task terminal, or not the input this hook is for: no decision.
      const input = ExitPlanInputSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!taskId || !input.success) return this.reply(res, 204);
      const output = await this.onPlan(taskId, input.data).catch(() => undefined);
      return output ? this.reply(res, 200, output) : this.reply(res, 204);
    } catch {
      return this.reply(res, 400);
    }
  }
}
