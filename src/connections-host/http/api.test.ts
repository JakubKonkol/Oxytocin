import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiResourceSchema } from '@shared/domain/project-resources';
import type { ResolvedApi } from '@shared/rpc/contracts/connections-host';
import { agentHeaders, checkAccess, joinUrl, normalizeApiPath } from './api-rules';
import { ApiService } from './api-service';
import { summarizeSpec } from './openapi';

describe('api rules', () => {
  it('normalizes paths without leaving the root', () => {
    expect(normalizeApiPath('/users/1?x=1#frag')).toEqual({ path: '/users/1', search: 'x=1' });
    expect(normalizeApiPath('users//2/./')).toEqual({ path: '/users/2/', search: '' });
    expect(normalizeApiPath('/a/b/../c')).toEqual({ path: '/a/c', search: '' });
    for (const bad of [
      'http://evil.example/x',
      '//evil.example/x',
      '/../etc',
      '/a/%2e%2e/b',
      '/a%2fb',
      '\\\\host\\x',
      '/a\nb',
    ])
      expect(() => normalizeApiPath(bad), bad).toThrow();
  });

  it('joins the base URL prefix and query', () => {
    expect(joinUrl('http://h:1/api/v1/?k=1', '/users', new URLSearchParams('a=2')).toString()).toBe(
      'http://h:1/api/v1/users?k=1&a=2',
    );
  });

  it('checks methods and paths', () => {
    const api = ApiResourceSchema.parse({
      id: 'a',
      name: 'bank',
      baseUrl: 'http://x',
      access: {
        methods: ['GET', 'POST'],
        confirmMethods: ['DELETE'],
        allowPaths: ['/api/**'],
        denyPaths: ['/api/admin/**'],
      },
    });
    expect(checkAccess(api, 'get', '/api/users')).toEqual({ confirm: false });
    expect(checkAccess(api, 'DELETE', '/api/users/1')).toEqual({ confirm: true });
    expect(() => checkAccess(api, 'PUT', '/api/users')).toThrow(/PUT is not allowed/);
    expect(() => checkAccess(api, 'GET', '/api/admin/x')).toThrow(/blocked/);
    expect(() => checkAccess(api, 'GET', '/other')).toThrow(/not among the allowed paths/);
  });

  it('drops headers agents may not set', () => {
    expect(
      agentHeaders(
        { Authorization: 'x', Cookie: 'c', 'X-Api-Key': 'k', Accept: 'text/plain', 'X-Bad': 'a\r\nb', Host: 'h' },
        ['x-api-key'],
      ),
    ).toEqual({
      headers: { Accept: 'text/plain' },
      dropped: ['Authorization', 'Cookie', 'X-Api-Key', 'X-Bad', 'Host'],
    });
  });
});

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Bank', version: '2' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        tags: ['users'],
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
      },
      post: {
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      NewUser: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer' } },
      },
      User: {
        allOf: [{ $ref: '#/components/schemas/NewUser' }, { type: 'object', properties: { id: { type: 'string' } } }],
      },
    },
  },
};

describe('openapi', () => {
  it('lists operations and describes one', () => {
    const list = summarizeSpec(SPEC, { allowed: (m) => m === 'GET' });
    expect(list).toContain('Bank 2 — 2 operations');
    expect(list).toContain('GET /users — List users [listUsers]');
    expect(list).toContain('POST /users [createUser] (not allowed)');
    const one = summarizeSpec(SPEC, { operation: 'createUser', allowed: () => true });
    expect(one).toContain('Body (application/json, required): { email: string (email); age?: integer }');
    expect(one).toContain('201 Created: { email: string (email); age?: integer } & { id?: string }');
    expect(summarizeSpec(SPEC, { filter: 'users', operation: 'GET /users', allowed: () => true })).toContain(
      'page (query): integer',
    );
  });
});

describe('ApiService against a local server', () => {
  let server: Server;
  let base: string;
  const requests: IncomingMessage[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req);
      if (req.url === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' });
        return res.end(JSON.stringify(SPEC));
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://example.invalid/steal' });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('x'.repeat(10_000));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc; HttpOnly' });
      res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const resolved = (access: Record<string, unknown> = {}): ResolvedApi => ({
    key: 'p/a',
    resource: ApiResourceSchema.parse({
      id: 'a',
      name: 'bank',
      baseUrl: base,
      auth: { type: 'bearer' },
      access: { maxResponseBytes: 4096, ...access },
    }),
    projectRoot: '/',
    baseUrl: base,
    secrets: { token: 'SECRET-TOKEN' },
  });

  it('adds the auth, scrubs it from responses and masks cookies', async () => {
    const r = await new ApiService().request({ ...resolved(), method: 'GET', path: '/users', query: { page: '2' } });
    expect(r.status).toBe('done');
    const text = r.status === 'done' ? r.text : '';
    expect(text).toContain('HTTP 200');
    expect(text).toContain('"url": "/users?page=2"');
    expect(text).toContain('"auth": "Bearer ***"');
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).toContain('set-cookie: sid=***');
    expect(requests.at(-1)?.headers.authorization).toBe('Bearer SECRET-TOKEN');
  });

  it('never follows redirects to another origin and caps bodies', async () => {
    const svc = new ApiService();
    const r = await svc.request({ ...resolved(), method: 'GET', path: '/redirect' });
    expect(r.status === 'done' && r.text).toContain('HTTP 302');
    expect(requests.some((q) => q.url === '/steal')).toBe(false);
    const big = await svc.request({ ...resolved(), method: 'GET', path: '/big' });
    expect(big.status === 'done' && big.text).toContain('[Body cut at 4 KB');
  });

  it('asks for confirm methods and refuses the rest', async () => {
    const svc = new ApiService();
    const ask = await svc.request({
      ...resolved({ confirmMethods: ['POST'] }),
      method: 'POST',
      path: '/users',
      body: { a: 1 },
    });
    expect(ask).toMatchObject({ status: 'needs-approval' });
    expect(ask.status === 'needs-approval' && ask.preview).toContain('{"a":1}');
    const done = await svc.request({
      ...resolved({ confirmMethods: ['POST'] }),
      method: 'POST',
      path: '/users',
      body: { a: 1 },
      approved: true,
    });
    expect(done.status).toBe('done');
    await expect(svc.request({ ...resolved(), method: 'DELETE', path: '/users/1' })).rejects.toThrow(
      /DELETE is not allowed/,
    );
  });

  it('describes the API and tests the connection', async () => {
    const svc = new ApiService();
    expect(await svc.describe(resolved())).toContain('GET /users — List users');
    const t = await svc.test(resolved());
    expect(t).toMatchObject({ ok: true, serverVersion: 'HTTP 200 OK' });
    expect(t.details?.join()).toContain('OpenAPI: 1 paths (/openapi.json)');
    const down = await svc.test({ ...resolved(), baseUrl: 'http://127.0.0.1:1' });
    expect(down).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
  });
});
