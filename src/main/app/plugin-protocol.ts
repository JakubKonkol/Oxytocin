import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { buildPluginCsp } from '@shared/security/plugin-csp';
import { mimeTypeFor, resolveAssetPath } from './app-protocol-handler';

export interface PluginProtocolOptions {
  /** Root folder of an enabled plugin, or null (unknown / disabled → 404). */
  pluginRoot: (pluginId: string) => string | null;
  dev: boolean;
}

const notFound = () => new Response('Not found', { status: 404 });

/**
 * `oxy-plugin://<pluginId>/<path>`: files of enabled plugins only, never
 * outside the plugin folder (traversal, encoded separators, absolute paths and symlinks are rejected), with the
 * view CSP on every response.
 */
export function createPluginProtocolHandler(opts: PluginProtocolOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405 });
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      return notFound();
    }
    const root = opts.pluginRoot(host);
    if (!root) return notFound();
    const filePath = resolveAssetPath(root, request.url, host);
    if (!filePath) return notFound();
    try {
      // Symlinks must not lead outside the plugin folder.
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
      const rel = relative(realRoot, realFile);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return notFound();
      const info = await stat(realFile);
      if (!info.isFile()) return notFound();
      const body = request.method === 'HEAD' ? null : await readFile(realFile);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mimeTypeFor(realFile),
          'Content-Security-Policy': buildPluginCsp(host, { dev: opts.dev }),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': opts.dev ? 'no-cache' : 'max-age=3600',
        },
      });
    } catch {
      return notFound();
    }
  };
}
