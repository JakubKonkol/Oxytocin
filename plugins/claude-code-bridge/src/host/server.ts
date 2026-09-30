import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HOOK_PATH } from './claude-plugin';
import type { HookInput } from './events';

export const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeStats {
  port: number | null;
  error: string | null;
  events: number;
  rejected: number;
  lastEventAt: number | null;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Local endpoint for Claude Code `http` hooks: 127.0.0.1 only, Bearer token, JSON body up to 1 MB. Answers 204 (an
 * empty 2xx means "no decision" to Claude Code, so permission prompts and prompts proceed normally), or 200 with the
 * hook's JSON output when the handler returns one (the resource brief with a session's first prompt).
 */
export class BridgeServer {
  private server: Server | undefined;
  readonly stats: BridgeStats = { port: null, error: null, events: 0, rejected: 0, lastEventAt: null };

  constructor(
    private readonly token: string,
    /** Handles an event; a returned object is sent back as the hook's JSON output (e.g. `additionalContext`). */
    private readonly onEvent: (terminalId: string, input: HookInput) => unknown,
    private readonly now: () => number = Date.now,
  ) {}

  async start(port: number): Promise<void> {
    await this.stop();
    try {
      this.server = await new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => void this.handle(req, res));
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
      this.stats.port = port;
      this.stats.error = null;
    } catch (e) {
      this.stats.port = null;
      this.stats.error =
        (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${port} is in use (another Oxytocin or another program). Choose another "claudeBridge.port".`
          : e instanceof Error
            ? e.message
            : String(e);
      throw e;
    }
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stats.port = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private reply(res: ServerResponse, status: number): void {
    if (status >= 400) this.stats.rejected++;
    res.writeHead(status);
    res.end();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) return this.reply(res, 404);
    const auth = String(req.headers['authorization'] ?? '');
    if (!sameSecret(auth, `Bearer ${this.token}`)) return this.reply(res, 401);
    const terminalId = String(req.headers['x-oxytocin-terminal'] ?? '');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return this.reply(res, 413);
        chunks.push(chunk as Buffer);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
      if (!input || typeof input !== 'object') return this.reply(res, 400);
      this.stats.events++;
      this.stats.lastEventAt = this.now();
      const output = terminalId
        ? await Promise.resolve(this.onEvent(terminalId, input)).catch(() => undefined)
        : undefined;
      if (output && typeof output === 'object') {
        const body = JSON.stringify(output);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      this.reply(res, 204);
    } catch {
      this.reply(res, 400);
    }
  }
}
