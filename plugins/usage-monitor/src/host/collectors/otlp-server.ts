import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface OtlpServerStats {
  port: number | null;
  packets: number;
  rejected: number;
  lastPacketAt: number | null;
}

/**
 * Local OTLP/HTTP receiver: 127.0.0.1 only, Bearer token, JSON (optionally
 * gzip); metrics are processed, logs and traces accepted and ignored. Protobuf is answered with 415 (S7: both CLIs
 * send JSON with the settings we inject).
 */
export class OtlpServer {
  private server: Server | undefined;
  readonly stats: OtlpServerStats = { port: null, packets: 0, rejected: 0, lastPacketAt: null };

  constructor(
    private readonly token: string,
    private readonly onMetrics: (body: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async start(preferredPort = 0): Promise<number> {
    const listen = (port: number) =>
      new Promise<Server>((resolve, reject) => {
        const server = createServer((req, res) => void this.handle(req, res));
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
    try {
      this.server = await listen(preferredPort);
    } catch {
      this.server = await listen(0);
    }
    const address = this.server.address();
    this.stats.port = typeof address === 'object' && address ? address.port : null;
    return this.stats.port!;
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.stats.port = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private reply(res: ServerResponse, status: number, body: unknown = {}): void {
    if (status >= 400) this.stats.rejected++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !['/v1/metrics', '/v1/logs', '/v1/traces'].includes(req.url ?? ''))
      return this.reply(res, 404, { error: 'not found' });
    if (req.headers['authorization'] !== `Bearer ${this.token}`) return this.reply(res, 401, { error: 'unauthorized' });
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/json')) return this.reply(res, 415, { error: 'only OTLP/JSON is supported' });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return this.reply(res, 413, { error: 'payload too large' });
        chunks.push(chunk as Buffer);
      }
      let raw = Buffer.concat(chunks);
      if (String(req.headers['content-encoding'] ?? '').includes('gzip')) raw = await gunzipAsync(raw);
      const body = JSON.parse(raw.toString('utf8')) as unknown;
      this.stats.packets++;
      this.stats.lastPacketAt = this.now();
      if (req.url === '/v1/metrics') this.onMetrics(body);
      this.reply(res, 200, {});
    } catch {
      this.reply(res, 400, { error: 'invalid payload' });
    }
  }
}
