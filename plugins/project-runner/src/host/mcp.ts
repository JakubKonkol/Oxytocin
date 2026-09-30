import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * The plugin's own MCP server `oxytocin-runner` from before Oxytocin had one (≤ 0.6.0), kept for one release so
 * Claude Code registrations made then keep working until the user connects Oxytocin's server (which removes the old
 * registration). Its tools are the Run tools under their old names; new installs never start it.
 *
 * A minimal Model Context Protocol server over Streamable HTTP (JSON responses, no SSE): `initialize`, `ping`,
 * `tools/list` and `tools/call`. Local only (127.0.0.1), Bearer token, Origin checked against DNS rebinding.
 */

export const MCP_PATH = '/mcp';
export const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  /**
   * Resolves the text shown to the agent; throws for tool errors (reported with `isError`). `context` comes from
   * Oxytocin's MCP server (the caller's project); the legacy server passes none.
   */
  handler: (args: Record<string, unknown>, context?: { projectId?: string }) => Promise<string>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

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

export class McpServer {
  private server: Server | undefined;
  private tools: McpTool[] = [];
  port: number | null = null;
  error: string | null = null;
  /** Tool calls served (for the status in the UI). */
  calls = 0;

  constructor(
    private readonly info: { name: string; version: string; instructions?: string },
    private readonly token: () => string,
  ) {}

  setTools(tools: McpTool[]): void {
    this.tools = tools;
  }

  async start(port: number): Promise<void> {
    await this.stop();
    try {
      this.server = await new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => void this.handle(req, res));
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
      this.port = port;
      this.error = null;
    } catch (e) {
      this.port = null;
      this.error =
        (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${port} is in use. Choose another "projectRunner.mcp.port".`
          : e instanceof Error
            ? e.message
            : String(e);
      throw e;
    }
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return this.send(res, 404);
    if (!isAllowedOrigin(req.headers.origin) || !isAllowedHost(req.headers.host)) return this.send(res, 403);
    if (!sameSecret(String(req.headers['authorization'] ?? ''), `Bearer ${this.token()}`))
      return this.send(res, 401, { error: 'unauthorized' });
    // No server-initiated stream (GET) and no session to delete.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.send(res, 405);
    }
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
    const messages = (batch ? body : [body]) as JsonRpcRequest[];
    const responses = (await Promise.all(messages.map((m) => this.dispatch(m)))).filter(
      (r): r is JsonRpcResponse => r !== null,
    );
    // Only notifications or responses: accepted without a body.
    if (responses.length === 0) return this.send(res, 202);
    this.send(res, 200, batch ? responses : responses[0]);
  }

  /** One JSON-RPC message → its response (null for notifications). */
  async dispatch(m: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      return m && typeof m === 'object' && 'id' in m && m.id !== undefined && !('result' in m || 'error' in m)
        ? { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid request' } }
        : null;
    }
    if (m.id === undefined || m.id === null) return null; // notification (notifications/initialized, …)
    const id = m.id;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const requested = str(m.params?.['protocolVersion']);
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: this.tools.map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const name = str(m.params?.['name']);
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = m.params?.['arguments'];
        this.calls++;
        try {
          const text = await tool.handler(args && typeof args === 'object' ? (args as Record<string, unknown>) : {});
          return ok({ content: [{ type: 'text', text }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }
}
