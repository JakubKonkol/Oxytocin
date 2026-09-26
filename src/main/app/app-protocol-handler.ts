import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a request URL to a file inside `rootDir`. Returns null for anything that escapes the root
 * (path traversal, encoded separators, absolute paths) or for a foreign host.
 */
export function resolveAssetPath(rootDir: string, requestUrl: string, expectedHost: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.host !== expectedHost) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const relativePath = pathname.replace(/^\/+/, '') || 'index.html';
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  return target;
}

export interface StaticHandlerOptions {
  rootDir: string;
  host: string;
  /** Extra headers (e.g. Content-Security-Policy) added to HTML responses. */
  htmlHeaders?: Record<string, string>;
}

/** A `protocol.handle` compatible handler serving static files from a directory. */
export function createStaticFileHandler(opts: StaticHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const filePath = resolveAssetPath(opts.rootDir, request.url, opts.host);
    if (!filePath) return new Response('Not found', { status: 404 });
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      const body = request.method === 'HEAD' ? null : await readFile(filePath);
      const contentType = mimeTypeFor(filePath);
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      };
      if (contentType.startsWith('text/html')) Object.assign(headers, opts.htmlHeaders);
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
