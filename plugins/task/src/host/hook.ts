import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

export const HOOK_PATH = '/task/exit-plan';
/** Set in the planner's terminal only: the task whose plan the hook hands over. */
export const TASK_VAR = 'OXYTOCIN_TASK_ID';
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How long Claude Code waits for the user's decision on a finished plan (seconds). The hook request stays open
 * while the plan is reviewed in Task, like Plannotator's plan review; pressing Esc in the terminal ends it.
 */
export const DECISION_TIMEOUT_S = 4 * 24 * 3600;

/** What Claude reads once the user decided in Task (the hook's `deny` reason ends or continues its turn). */
export const DECISION_REASONS = {
  approved:
    'The user approved this plan in Oxytocin. A separate agent implements it. Do not implement anything, do not ' +
    'call ExitPlanMode again and end your turn now with one short sentence.',
  rejected:
    'The user rejected this plan in Oxytocin. Do not implement anything, do not call ExitPlanMode again and end ' +
    'your turn now.',
  deleted: 'The task was deleted in Oxytocin. Do not implement anything and end your turn now.',
  revise: (feedback: string) =>
    'The user reviewed the plan in Oxytocin and asks for changes. Stay in plan mode, do not implement anything, ' +
    'revise the plan with the feedback below and finish the whole revised plan with ExitPlanMode again.\n\n' +
    `Feedback:\n${feedback}`,
} as const;

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
 * The `--settings` file of a Claude Code session started by Task: reading Task's folder (the task and the brief) asks
 * no permission; `write` also lets a planner without the plan hook write its plan there. This is an allow rule rather
 * than `--add-dir`, which keeps the prompt on Claude Code's command line from being submitted
 * (anthropics/claude-code#92930).
 */
export function taskFolderSettings(taskDir: string, write = false) {
  const dir = absoluteRulePath(taskDir);
  return { permissions: { allow: [`Read(${dir}/**)`, ...(write ? [`Edit(${dir}/**)`] : [])] } };
}

/**
 * The `--settings` file of a planning session (it only adds to the user's and the project's settings):
 * - a `PreToolUse` hook on `ExitPlanMode` that hands the finished plan to Task over HTTP and waits for the user's
 *   decision (approve, feedback or reject), which Task returns as the hook's answer: nothing is typed into the
 *   terminal. An `http` hook needs no shell (no bash, jq or PowerShell on Windows); Claude Code interpolates the task
 *   id from the terminal's environment. Outside a Task terminal the id is empty and Task answers "no decision"; when
 *   Oxytocin does not answer, the request fails as a non-blocking hook error and Claude Code asks in the terminal as
 *   usual, so the plan is never lost.
 * - reading Task's folder (see `taskFolderSettings`);
 * - deny rules: with bypass permissions available Claude Code does not enforce plan mode's blocks in an interactive
 *   terminal, so edits inside the project and git commands that change history or the working tree are denied.
 *   Claude Code writes its plan file outside the project (`~/.claude/plans/` or `plansDirectory`).
 */
export function plannerSettings(o: { projectRoot: string; taskDir: string; url: string; token: string }) {
  return {
    permissions: {
      allow: taskFolderSettings(o.taskDir).permissions.allow,
      deny: [`Edit(${absoluteRulePath(o.projectRoot)}/**)`, ...GIT_DENY],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'ExitPlanMode',
          hooks: [
            {
              type: 'http',
              url: o.url,
              timeout: DECISION_TIMEOUT_S,
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

/** The hook's answer: Claude reads `reason` and does not leave plan mode (no question in the terminal). */
export const decision = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * 127.0.0.1 only, Bearer token, JSON up to 1 MB. The handler's object is the hook's JSON output; `undefined` answers
 * 204, which Claude Code reads as "no decision" (its usual approval question follows). The handler may take as long
 * as the user needs: `closed` aborts when Claude Code stops waiting (Esc, its timeout, the session ended).
 *
 * HTTP clients give up on a response that sends nothing for minutes (undici: 300 s for the headers and between body
 * chunks), so a decision that takes longer than `keepAlive.afterMs` gets its 200 headers at once and a space every
 * `keepAlive.everyMs`. Claude Code trims the body before parsing it as JSON, and reads a blank body as "no decision".
 */
export class PlanHookServer {
  private server: Server | undefined;

  constructor(
    private readonly token: string,
    private readonly onPlan: (taskId: string, input: ExitPlanInput, closed: AbortSignal) => Promise<object | undefined>,
    private readonly keepAlive = { afterMs: 5000, everyMs: 30_000 },
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
    // Waiting hook requests end too: Claude Code then asks in its terminal.
    server?.closeAllConnections();
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
      const closed = new AbortController();
      res.on('close', () => closed.abort());
      let started = false;
      let beat: ReturnType<typeof setInterval> | undefined;
      const begin = setTimeout(() => {
        started = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(' ');
        beat = setInterval(() => res.write(' '), this.keepAlive.everyMs);
      }, this.keepAlive.afterMs);
      const output = await this.onPlan(taskId, input.data, closed.signal)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(begin);
          clearInterval(beat);
        });
      if (closed.signal.aborted) return;
      if (started) return void res.end(output ? JSON.stringify(output) : '');
      return output ? this.reply(res, 200, output) : this.reply(res, 204);
    } catch {
      return this.reply(res, 400);
    }
  }
}
