import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isLoopback } from '../db/tls';

export interface HttpResult {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was longer than the limit and was cut. */
  truncated: boolean;
  /** The final URL after same-origin redirects. */
  url: URL;
  redirects: number;
}

export interface HttpOptions {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes: number;
  /** Ignore certificate errors (only ever for loopback hosts). */
  insecureLoopback: boolean;
  maxRedirects?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function once(url: URL, o: HttpOptions): Promise<Omit<HttpResult, 'url' | 'redirects'>> {
  return new Promise((resolve, reject) => {
    const https = url.protocol === 'https:';
    const insecure = https && o.insecureLoopback && isLoopback(url.hostname.replace(/^\[|\]$/g, ''));
    const req = (https ? httpsRequest : httpRequest)(
      url,
      {
        method: o.method,
        headers: { ...o.headers, ...(o.body ? { 'Content-Length': String(o.body.length) } : {}) },
        ...(https ? { rejectUnauthorized: !insecure } : {}),
        // No proxy and no connection reuse across calls: every request goes straight to the configured origin.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > o.maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - o.maxBytes)));
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (e) => {
          if (!truncated) {
            clearTimeout(timer);
            reject(e);
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new HttpError(`Timeout: no response within ${Math.round(o.timeoutMs / 1000)} s`, 'ETIMEDOUT'));
    }, o.timeoutMs);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (o.body) req.end(o.body);
    else req.end();
  });
}

/**
 * One HTTP request with redirects followed only within the same origin (auth headers never leave it), at most 5.
 * 303 (and 301/302 for non-GET) turn into a GET without a body, like browsers do.
 */
export async function httpCall(url: URL, o: HttpOptions): Promise<HttpResult> {
  let current = url;
  let options = o;
  const max = o.maxRedirects ?? 5;
  for (let redirects = 0; ; redirects++) {
    const r = await once(current, options);
    const location = r.headers.location;
    if (r.status < 300 || r.status >= 400 || r.status === 304 || !location || redirects >= max)
      return { ...r, url: current, redirects };
    const next = new URL(location, current);
    if (next.origin !== url.origin) return { ...r, url: current, redirects };
    if (
      r.status === 303 ||
      ((r.status === 301 || r.status === 302) && options.method !== 'GET' && options.method !== 'HEAD')
    ) {
      const { body: _body, ...rest } = options;
      const headers = Object.fromEntries(
        Object.entries(rest.headers).filter(([k]) => k.toLowerCase() !== 'content-type'),
      );
      options = { ...rest, method: options.method === 'HEAD' ? 'HEAD' : 'GET', headers };
    }
    current = next;
  }
}
