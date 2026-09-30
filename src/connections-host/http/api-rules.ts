import type { ApiResource, HttpMethod } from '@shared/domain/project-resources';
import { pathGlob } from '@shared/utils/glob';

export class ApiRuleError extends Error {}

/**
 * The path an agent asked for, normalized: a path on the API (no scheme or host), `.` and `..` resolved without
 * leaving the root, no encoded slashes or dots that a server could decode into another path. Returns the path and
 * the query string split off it.
 */
export function normalizeApiPath(raw: string): { path: string; search: string } {
  const input = raw.trim();
  if (!input) return { path: '/', search: '' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith('//') || input.startsWith('\\'))
    throw new ApiRuleError('Pass a path on the API (e.g. /users/1), not a full URL: requests only go to the base URL.');
  if (input.includes('\\')) throw new ApiRuleError('Backslashes are not allowed in the path.');
  if (/%(2e|2f|5c|00)/i.test(input))
    throw new ApiRuleError('Encoded dots, slashes or NUL bytes are not allowed in the path.');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this check rejects
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new ApiRuleError('Control characters are not allowed in the path.');
  const hash = input.indexOf('#');
  const noHash = hash >= 0 ? input.slice(0, hash) : input;
  const q = noHash.indexOf('?');
  const pathPart = q >= 0 ? noHash.slice(0, q) : noHash;
  const search = q >= 0 ? noHash.slice(q + 1) : '';
  const out: string[] = [];
  for (const segment of pathPart.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw new ApiRuleError('The path leaves the API root (..).');
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const trailing = pathPart.endsWith('/') && out.length > 0 ? '/' : '';
  return { path: `/${out.join('/')}${trailing}`, search };
}

/** The full URL: base URL (with its own path prefix) + the normalized path. */
export function joinUrl(baseUrl: string, path: string, query: URLSearchParams): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin);
  url.pathname = `${prefix}${path}`;
  const merged = new URLSearchParams(base.search);
  for (const [k, v] of query) merged.append(k, v);
  url.search = merged.toString();
  return url;
}

/** Whether the method and path pass the resource's rules; `confirm` when the user must approve the call. */
export function checkAccess(
  api: Pick<ApiResource, 'access' | 'name'>,
  method: string,
  path: string,
): { confirm: boolean } {
  const m = method.toUpperCase() as HttpMethod;
  const allowed = new Set([...api.access.methods, ...api.access.confirmMethods]);
  if (!allowed.has(m))
    throw new ApiRuleError(
      `${m} is not allowed on "${api.name}" (allowed: ${[...allowed].join(', ') || 'none'}). Ask the user to allow it in Project settings → APIs if it is needed.`,
    );
  const bare = path.replace(/\/$/, '') || '/';
  if (api.access.denyPaths.some((g) => pathGlob(g).test(bare) || pathGlob(g).test(path)))
    throw new ApiRuleError(`${path} is blocked for agents on "${api.name}".`);
  if (!api.access.allowPaths.some((g) => pathGlob(g).test(bare) || pathGlob(g).test(path)))
    throw new ApiRuleError(
      `${path} is not among the allowed paths of "${api.name}" (${api.access.allowPaths.join(', ')}).`,
    );
  return { confirm: api.access.confirmMethods.includes(m) };
}

/** Headers agents may not set: auth, cookies, hop-by-hop and framing headers. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

/** The agent's headers without the forbidden ones and without the names the auth uses. */
export function agentHeaders(
  headers: Record<string, unknown> | undefined,
  authNames: readonly string[],
): { headers: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  const auth = new Set(authNames.map((n) => n.toLowerCase()));
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,200}$/.test(name) ||
      FORBIDDEN_HEADERS.has(lower) ||
      auth.has(lower) ||
      lower.startsWith('proxy-')
    ) {
      dropped.push(name);
      continue;
    }
    const text = String(value);
    if (/[\r\n\0]/.test(text)) {
      dropped.push(name);
      continue;
    }
    out[name] = text;
  }
  return { headers: out, dropped };
}
