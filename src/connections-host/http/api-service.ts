import { readFile } from 'node:fs/promises';
import { apiSecretKeys, type ResourceTestResult } from '@shared/domain/project-resources';
import type { ApiRequest, Classification, GuardOutcome, ResolvedApi } from '@shared/rpc/contracts/connections-host';
import { OxyError } from '@shared/errors';
import { scrub } from '../format';
import { projectPath } from '../db/target';
import { agentHeaders, ApiRuleError, checkAccess, joinUrl, normalizeApiPath } from './api-rules';
import { httpCall, type HttpResult } from './http-client';
import { OPENAPI_CANDIDATES, parseSpec, summarizeSpec } from './openapi';

const SPEC_CACHE_MS = 60_000;
const SPEC_MAX_BYTES = 10 * 1024 * 1024;
const SHOWN_HEADERS =
  /^(content-type|content-length|location|retry-after|etag|last-modified|www-authenticate|allow|x-request-id|x-correlation-id|(x-)?rate-?limit.*|set-cookie)$/i;

/** Auth headers and query parameters for a request (secrets from main). */
export function authFor(api: ResolvedApi): {
  headers: Record<string, string>;
  query: [string, string][];
  names: string[];
} {
  const a = api.resource.auth;
  const s = api.secrets;
  switch (a.type) {
    case 'bearer':
      return {
        headers: s['token'] ? { Authorization: `Bearer ${s['token']}` } : {},
        query: [],
        names: ['authorization'],
      };
    case 'basic':
      return {
        headers: { Authorization: `Basic ${Buffer.from(`${a.user}:${s['password'] ?? ''}`).toString('base64')}` },
        query: [],
        names: ['authorization'],
      };
    case 'api-key':
      return a.in === 'header'
        ? { headers: s['apiKey'] ? { [a.name]: s['apiKey'] } : {}, query: [], names: [a.name] }
        : { headers: {}, query: s['apiKey'] ? [[a.name, s['apiKey']]] : [], names: [] };
    case 'headers':
      return {
        headers: Object.fromEntries(
          a.names.filter((n) => s[`header:${n}`] !== undefined).map((n) => [n, s[`header:${n}`]!]),
        ),
        query: [],
        names: a.names,
      };
    default:
      return { headers: {}, query: [], names: [] };
  }
}

const secretsOf = (api: ResolvedApi) => {
  const values = Object.values(api.secrets);
  const basic =
    api.resource.auth.type === 'basic'
      ? [Buffer.from(`${api.resource.auth.user}:${api.secrets['password'] ?? ''}`).toString('base64')]
      : [];
  return [...values, ...basic];
};

const isText = (type: string) =>
  /^(text\/|application\/(.+\+)?(json|xml|javascript|x-www-form-urlencoded|yaml|x-yaml|problem\+json|graphql))/i.test(
    type,
  ) || type === '';

/** The response as the agent sees it: status, selected headers, body (JSON pretty-printed), secrets removed. */
export function formatResponse(r: HttpResult, secrets: readonly string[], maxBytes: number): string {
  const lines = [`HTTP ${r.status} ${r.statusText}`.trim()];
  if (r.redirects)
    lines.push(`(followed ${r.redirects} redirect${r.redirects === 1 ? '' : 's'} to ${r.url.pathname}${r.url.search})`);
  for (const [name, value] of Object.entries(r.headers)) {
    if (!SHOWN_HEADERS.test(name) || value === undefined) continue;
    if (name.toLowerCase() === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [value];
      lines.push(`${name}: ${cookies.map((c) => c.replace(/=([^;]*)/, '=***')).join(', ')}`);
    } else lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  const type = String(r.headers['content-type'] ?? '');
  let body: string;
  if (r.body.length === 0) body = '(empty body)';
  else if (!isText(type))
    body = `<${type || 'binary'} body, ${r.body.length.toLocaleString('en-US')} bytes${r.truncated ? ' (cut)' : ''}>`;
  else {
    body = r.body.toString('utf8');
    if (/json/i.test(type) && !r.truncated) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Not valid JSON after all: shown as text.
      }
    }
    if (body.length > maxBytes) body = `${body.slice(0, maxBytes)}…`;
    if (r.truncated || body.endsWith('…'))
      body += `\n[Body cut at ${Math.round(maxBytes / 1024)} KB; ask for less (filters, paging, a smaller page size).]`;
  }
  return scrub(`${lines.join('\n')}\n\n${body}`, secrets);
}

/** The API side of the bridge: requests with the user's rules and auth added, OpenAPI summaries, tests. */
export class ApiService {
  private readonly specs = new Map<
    string,
    { at: number; etag?: string; spec: Record<string, unknown>; source: string }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  private insecure(api: ResolvedApi) {
    return api.resource.access.allowSelfSignedOnLoopback;
  }

  private base(api: ResolvedApi): URL {
    try {
      const u = new URL(api.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      return u;
    } catch {
      throw new OxyError('INVALID', `${api.resource.name}: the base URL "${api.baseUrl}" is not an http(s) address.`);
    }
  }

  private fail(api: ResolvedApi, e: unknown): never {
    if (e instanceof OxyError) throw e;
    if (e instanceof ApiRuleError) throw new OxyError('PERMISSION', e.message);
    const message = scrub(
      e instanceof Error
        ? `${(e as { code?: string }).code ? `${(e as { code?: string }).code}: ` : ''}${e.message}`
        : String(e),
      secretsOf(api),
    );
    const hint = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(message)
      ? ' The API is not reachable: is it running? (If it comes from a Run profile, start it with run_start_profile.)'
      : /certificate|self[- ]signed/i.test(message)
        ? ' The certificate is not trusted; for a local development certificate turn on "Allow self-signed certificates on localhost".'
        : '';
    throw new OxyError('UNAVAILABLE', `${api.resource.name}: ${message}.${hint}`);
  }

  async request(req: ApiRequest): Promise<GuardOutcome> {
    const api = req.resource;
    const method = String(req.method ?? 'GET').toUpperCase();
    const classification: Classification = {
      kind: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write',
      statement: method,
      tables: [],
      reasons: [],
      dangerous: [],
    };
    try {
      const { path, search } = normalizeApiPath(String(req.path ?? '/'));
      classification.tables = [path];
      const { confirm } = checkAccess(api, method, path);
      const query = new URLSearchParams(search);
      for (const [k, v] of Object.entries(req.query ?? {})) query.append(k, String(v));
      const auth = authFor(req);
      const { headers, dropped } = agentHeaders(req.headers, auth.names);
      let body: Buffer | undefined;
      if (req.body !== undefined && req.body !== null && !['GET', 'HEAD'].includes(method)) {
        if (typeof req.body === 'string') body = Buffer.from(req.body);
        else {
          body = Buffer.from(JSON.stringify(req.body));
          if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
            headers['Content-Type'] = 'application/json';
        }
      }
      const url = joinUrl(this.base(req).toString(), path, query);
      for (const [k, v] of auth.query) url.searchParams.set(k, v);
      if (confirm && !req.approved) {
        const preview = `${method} ${url.pathname}${query.size ? `?${query.toString()}` : ''}${body ? `\n\n${body.toString('utf8').slice(0, 10_000)}` : ''}`;
        return {
          status: 'needs-approval',
          message: `${method} on "${api.name}" asks the user first.`,
          classification,
          preview,
        };
      }
      const r = await httpCall(url, {
        method,
        headers: { Accept: 'application/json, */*;q=0.8', 'User-Agent': 'Oxytocin', ...headers, ...auth.headers },
        ...(body ? { body } : {}),
        timeoutMs: api.access.timeoutMs,
        maxBytes: api.access.maxResponseBytes,
        insecureLoopback: this.insecure(req),
      });
      const note = dropped.length
        ? `\n(Headers not sent: ${dropped.join(', ')} — Oxytocin adds the authentication.)`
        : '';
      return {
        status: 'done',
        text: `${formatResponse(r, secretsOf(req), api.access.maxResponseBytes)}${note}`,
        classification,
      };
    } catch (e) {
      this.fail(req, e);
    }
  }

  private async loadSpec(api: ResolvedApi): Promise<{ spec: Record<string, unknown>; source: string } | null> {
    const openapi = api.resource.openapi;
    if (openapi.source === 'off') return null;
    const cached = this.specs.get(api.key);
    if (cached && this.now() - cached.at < SPEC_CACHE_MS) return cached;
    if (openapi.source === 'file') {
      if (!openapi.value) throw new OxyError('INVALID', `${api.resource.name}: the OpenAPI file is not set.`);
      const text = await readFile(projectPath(api.projectRoot, openapi.value), 'utf8');
      const spec = parseSpec(text);
      if (!spec) throw new OxyError('INVALID', `${openapi.value} is not an OpenAPI document.`);
      const entry = { at: this.now(), spec, source: openapi.value };
      this.specs.set(api.key, entry);
      return entry;
    }
    const base = this.base(api);
    const candidates = openapi.source === 'url' && openapi.value ? [openapi.value] : OPENAPI_CANDIDATES;
    const auth = authFor(api);
    for (const candidate of candidates) {
      let url: URL;
      if (/^https?:\/\//i.test(candidate)) {
        url = new URL(candidate);
        // Credentials only go to the API's own origin.
      } else url = joinUrl(base.toString(), normalizeApiPath(candidate).path, new URLSearchParams());
      const sameOrigin = url.origin === base.origin;
      if (sameOrigin) for (const [k, v] of auth.query) url.searchParams.set(k, v);
      try {
        const r = await httpCall(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json, application/yaml;q=0.9, */*;q=0.5',
            'User-Agent': 'Oxytocin',
            ...(sameOrigin ? auth.headers : {}),
            ...(cached?.etag && cached.source === url.pathname ? { 'If-None-Match': cached.etag } : {}),
          },
          timeoutMs: Math.min(api.resource.access.timeoutMs, 15_000),
          maxBytes: SPEC_MAX_BYTES,
          insecureLoopback: this.insecure(api),
        });
        if (r.status === 304 && cached) {
          cached.at = this.now();
          return cached;
        }
        if (r.status !== 200 || r.truncated) continue;
        const spec = parseSpec(r.body.toString('utf8'));
        if (!spec) continue;
        const etag = typeof r.headers.etag === 'string' ? r.headers.etag : undefined;
        const entry = { at: this.now(), spec, source: url.pathname, ...(etag ? { etag } : {}) };
        this.specs.set(api.key, entry);
        return entry;
      } catch {
        if (openapi.source === 'url')
          throw new OxyError('UNAVAILABLE', `The OpenAPI document ${candidate} could not be loaded.`);
      }
    }
    return null;
  }

  async describe(api: ResolvedApi & { filter?: string; operation?: string }): Promise<string> {
    let loaded;
    try {
      loaded = await this.loadSpec(api);
    } catch (e) {
      this.fail(api, e);
    }
    if (!loaded)
      return `${api.resource.name} has no OpenAPI document${api.resource.openapi.source === 'off' ? ' configured' : ` at ${OPENAPI_CANDIDATES.join(', ')}`}. Call endpoints with oxy_api_request; the project's code (controllers, routes) describes them.`;
    const allowed = (method: string, path: string) => {
      try {
        checkAccess(api.resource, method, path.replace(/\{[^}]+\}/g, 'x'));
        return true;
      } catch {
        return false;
      }
    };
    return summarizeSpec(loaded.spec, {
      ...(api.filter ? { filter: api.filter } : {}),
      ...(api.operation ? { operation: api.operation } : {}),
      allowed,
    });
  }

  async test(api: ResolvedApi): Promise<ResourceTestResult> {
    const started = this.now();
    try {
      const base = this.base(api);
      const { path } = normalizeApiPath(api.resource.healthPath ?? '/');
      const url = joinUrl(base.toString(), path, new URLSearchParams());
      const auth = authFor(api);
      for (const [k, v] of auth.query) url.searchParams.set(k, v);
      const missing = apiSecretKeys(api.resource).filter((k) => api.secrets[k] === undefined);
      const r = await httpCall(url, {
        method: 'GET',
        headers: { Accept: '*/*', 'User-Agent': 'Oxytocin', ...auth.headers },
        timeoutMs: Math.min(api.resource.access.timeoutMs, 15_000),
        maxBytes: 64 * 1024,
        insecureLoopback: this.insecure(api),
      });
      const latencyMs = this.now() - started;
      const details: string[] = [];
      if (missing.length) details.push(`Not set: ${missing.join(', ')}.`);
      this.specs.delete(api.key);
      const spec = await this.loadSpec(api).catch(() => null);
      if (spec)
        details.push(
          `OpenAPI: ${Object.keys((spec.spec['paths'] as Record<string, unknown>) ?? {}).length} paths (${spec.source}).`,
        );
      else if (api.resource.openapi.source !== 'off') details.push('No OpenAPI document found.');
      const ok = r.status < 500 && r.status !== 401 && r.status !== 403;
      return {
        ok,
        serverVersion: `HTTP ${r.status} ${r.statusText}`.trim(),
        latencyMs,
        ...(ok
          ? {}
          : {
              error: {
                kind: r.status === 401 || r.status === 403 ? 'auth' : 'http',
                message: `HTTP ${r.status} ${r.statusText} from ${url.pathname}`,
              },
            }),
        details,
      };
    } catch (e) {
      const message = scrub(e instanceof Error ? e.message : String(e), secretsOf(api));
      const code = (e as { code?: string }).code ?? '';
      return {
        ok: false,
        latencyMs: this.now() - started,
        error: {
          kind: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/.test(`${code} ${message}`)
            ? 'unreachable'
            : /certificate|self[- ]signed|SSL|TLS/i.test(`${code} ${message}`)
              ? 'tls'
              : /ETIMEDOUT|Timeout/i.test(`${code} ${message}`)
                ? 'timeout'
                : e instanceof OxyError
                  ? 'config'
                  : 'other',
          message: `${code && !message.includes(code) ? `${code}: ` : ''}${message}`,
        },
      };
    }
  }

  forget(keys?: string[]): void {
    for (const key of this.specs.keys()) if (!keys || keys.includes(key)) this.specs.delete(key);
  }
}
