import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpToolAnnotations, McpToolResult } from '@shared/domain/mcp';
import { Emitter } from '@shared/utils/emitter';

/**
 * Oxytocin's MCP server over Streamable HTTP (MCP 2025-06-18, also 2025-03-26 and 2024-11-05 clients):
 * `POST /mcp` carries JSON-RPC requests (answered with JSON), `GET /mcp` opens the session's server → client SSE
 * stream (`notifications/tools/list_changed`), `DELETE /mcp` ends a session.
 *
 * Local only: bound to 127.0.0.1, a Bearer token on every request, Host and Origin checked against DNS rebinding.
 */

export const MCP_PATH = '/mcp';
export const MAX_BODY_BYTES = 1024 * 1024;
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_SESSIONS = 32;
const HEARTBEAT_MS = 20_000;

/** A tool as listed to clients. */
export interface ListedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface ToolCall {
  sessionId: string;
  /** `X-Oxytocin-Terminal` header (a hint: the id of the terminal the agent runs in). */
  terminalHeader?: string;
  /** Aborted when the client cancels the call or ends its session, or the server stops. */
  signal: AbortSignal;
}

/** What the transport asks the hub. */
export interface McpHandler {
  /** Server info for `initialize`; the terminal header lets the instructions describe the caller's project. */
  info(terminalHeader?: string): { name: string; version: string; instructions?: string };
  listTools(): ListedTool[];
  hasTool(name: string): boolean;
  callTool(name: string, args: Record<string, unknown>, call: ToolCall): Promise<McpToolResult>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

interface Session {
  id: string;
  lastSeen: number;
  stream?: ServerResponse;
  heartbeat?: ReturnType<typeof setInterval>;
  /** In-flight tool calls by JSON-RPC id (for `notifications/cancelled`). */
  inflight: Map<string, AbortController>;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * DNS rebinding guard: a remote page whose name resolves to 127.0.0.1 sends its own name as Host. Only loopback
 * names are accepted (clients connect to 127.0.0.1 or localhost).
 */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** Browsers send an Origin; only local pages may talk to the server (a remote page could rebind DNS to 127.0.0.1). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

const requestKey = (id: unknown) => JSON.stringify(id);

export class McpHttpServer {
  private server: Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionsEmitter = new Emitter<number>();
  /** The number of open sessions changed. */
  readonly onDidChangeSessions = this.sessionsEmitter.event;
  port: number | null = null;
  error: string | null = null;
  /** Tool calls served. */
  calls = 0;

  constructor(
    private readonly handler: McpHandler,
    private readonly token: () => string,
    private readonly options: { heartbeatMs?: number; maxSessions?: number; portSetting?: string } = {},
  ) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  async start(port: number): Promise<void> {
    await this.stop();
    try {
      this.server = await new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => {
          this.handle(req, res).catch(() => {
            if (!res.headersSent) this.send(res, 500);
            else res.end();
          });
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
      const address = this.server.address();
      this.port = typeof address === 'object' && address ? address.port : port;
      this.error = null;
    } catch (e) {
      this.port = null;
      this.error =
        (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${port} is in use. Choose another "${this.options.portSetting ?? 'mcp.port'}".`
          : e instanceof Error
            ? e.message
            : String(e);
      throw e;
    }
  }

  /** Stops listening; open streams and in-flight calls end first (an open stream would keep `close` waiting). */
  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = null;
    for (const id of [...this.sessions.keys()]) this.endSession(id);
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** Tells every connected client that the tool list changed (`notifications/tools/list_changed`). */
  notifyToolsChanged(): number {
    return this.broadcast({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  private broadcast(message: unknown): number {
    const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    let sent = 0;
    for (const session of this.sessions.values()) {
      if (!session.stream || session.stream.writableEnded) continue;
      session.stream.write(data);
      sent++;
    }
    return sent;
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(text)),
    });
    res.end(text);
  }

  private endSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.stream && !session.stream.writableEnded) session.stream.end();
    for (const controller of session.inflight.values()) controller.abort();
    session.inflight.clear();
    this.sessionsEmitter.fire(this.sessions.size);
  }

  private createSession(): Session {
    const max = this.options.maxSessions ?? MAX_SESSIONS;
    if (this.sessions.size >= max) {
      // Clients that went away without DELETE leave sessions behind: the least recently used one goes.
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.endSession(oldest.id);
    }
    const session: Session = {
      id: randomBytes(16).toString('base64url'),
      lastSeen: Date.now(),
      inflight: new Map(),
    };
    this.sessions.set(session.id, session);
    this.sessionsEmitter.fire(this.sessions.size);
    return session;
  }

  /** The request's session: 400 without an id, 404 for an unknown or ended one (the client then initializes again). */
  private sessionOf(req: IncomingMessage, res: ServerResponse): Session | null {
    const id = req.headers['mcp-session-id'];
    if (typeof id !== 'string' || !id) {
      this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Missing Mcp-Session-Id' } });
      return null;
    }
    const session = this.sessions.get(id);
    if (!session) {
      this.send(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } });
      return null;
    }
    session.lastSeen = Date.now();
    return session;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return this.send(res, 404);
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedHost(req.headers.host)) return this.send(res, 403);
    if (!sameSecret(String(req.headers['authorization'] ?? ''), `Bearer ${this.token()}`))
      return this.send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version))
      return this.send(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `Unsupported MCP-Protocol-Version: ${version}` },
      });
    switch (req.method) {
      case 'POST':
        return this.handlePost(req, res);
      case 'GET':
        return this.openStream(req, res);
      case 'DELETE': {
        const session = this.sessionOf(req, res);
        if (!session) return;
        this.endSession(session.id);
        return this.send(res, 204);
      }
      default:
        return this.send(res, 405, undefined, { Allow: 'GET, POST, DELETE' });
    }
  }

  private openStream(req: IncomingMessage, res: ServerResponse): void {
    if (!String(req.headers.accept ?? '').includes('text/event-stream'))
      return this.send(res, 406, undefined, { Allow: 'GET, POST, DELETE' });
    const session = this.sessionOf(req, res);
    if (!session) return;
    // One stream per session: a new GET replaces the old one.
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.stream && !session.stream.writableEnded) session.stream.end();
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Mcp-Session-Id': session.id,
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    session.stream = res;
    session.heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    res.on('close', () => {
      if (session.stream !== res) return;
      if (session.heartbeat) clearInterval(session.heartbeat);
      session.stream = undefined;
      session.heartbeat = undefined;
    });
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    let body: unknown;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return this.send(res, 413);
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    const initializing = messages.some((m) => m && typeof m === 'object' && m.method === 'initialize');
    let session: Session | null;
    if (initializing) session = this.createSession();
    else {
      session = this.sessionOf(req, res);
      if (!session) return;
    }
    const terminal = req.headers['x-oxytocin-terminal'];
    const responses = (
      await Promise.all(messages.map((m) => this.dispatch(m, session, typeof terminal === 'string' ? terminal : '')))
    ).filter((r): r is JsonRpcResponse => r !== null);
    const headers = { 'Mcp-Session-Id': session.id };
    // Only notifications or responses: accepted without a body.
    if (responses.length === 0) return this.send(res, 202, undefined, headers);
    this.send(res, 200, batch ? responses : responses[0], headers);
  }

  /** One JSON-RPC message → its response (null for notifications and client responses). */
  async dispatch(m: JsonRpcMessage, session: Session, terminalHeader = ''): Promise<JsonRpcResponse | null> {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      return m && typeof m === 'object' && 'id' in m && m.id !== undefined && !('result' in m || 'error' in m)
        ? { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid request' } }
        : null;
    }
    if (m.id === undefined || m.id === null) {
      if (m.method === 'notifications/cancelled') {
        session.inflight.get(requestKey(m.params?.['requestId']))?.abort();
      }
      return null;
    }
    const id = m.id;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const requested = str(m.params?.['protocolVersion']);
        const info = this.handler.info(terminalHeader || undefined);
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.handler.listTools() });
      case 'tools/call': {
        const name = str(m.params?.['name']);
        if (!this.handler.hasTool(name)) return fail(-32602, `Unknown tool: ${name}`);
        const args = m.params?.['arguments'];
        const controller = new AbortController();
        const key = requestKey(id);
        session.inflight.set(key, controller);
        this.calls++;
        try {
          const result = await this.handler.callTool(
            name,
            args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
            {
              sessionId: session.id,
              ...(terminalHeader ? { terminalHeader } : {}),
              signal: controller.signal,
            },
          );
          return ok(result);
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
        } finally {
          if (session.inflight.get(key) === controller) session.inflight.delete(key);
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }

  dispose(): Promise<void> {
    this.sessionsEmitter.dispose();
    return this.stop();
  }
}
