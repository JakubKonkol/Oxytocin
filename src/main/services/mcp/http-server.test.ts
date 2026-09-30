import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpToolResult } from '@shared/domain/mcp';
import { isAllowedHost, isAllowedOrigin, type ListedTool, McpHttpServer, type ToolCall } from './http-server';

const servers: McpHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTP request (Host can be set, unlike with fetch). */
function raw(
  port: number,
  o: { method: string; headers?: Record<string, string>; body?: string; path?: string },
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: o.path ?? '/mcp', method: o.method, headers: o.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(o.body);
  });
}

async function start(
  tools: ListedTool[] = [],
  handler?: (name: string, args: Record<string, unknown>, call: ToolCall) => Promise<McpToolResult>,
) {
  const calls: { name: string; args: Record<string, unknown>; call: ToolCall }[] = [];
  const server = new McpHttpServer(
    {
      info: () => ({ name: 'oxytocin', version: '1.0.0', instructions: 'Use cwd.' }),
      listTools: () => tools,
      hasTool: (name) => tools.some((t) => t.name === name),
      callTool: async (name, args, call) => {
        calls.push({ name, args, call });
        if (handler) return handler(name, args, call);
        if (args['text'] === 'fail') throw new Error('It failed');
        return { content: [{ type: 'text', text: `echo: ${String(args['text'])}` }] };
      },
    },
    () => 'secret',
    { heartbeatMs: 50 },
  );
  servers.push(server);
  await server.start(0);
  const port = server.port!;
  const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await raw(port, { method: 'POST', headers: { ...auth, ...headers }, body: JSON.stringify(body) });
    return { ...r, json: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : undefined };
  };
  const initialize = async () => {
    const r = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    return String(r.headers['mcp-session-id']);
  };
  return { server, port, post, initialize, calls, auth };
}

const echo: ListedTool = {
  name: 'echo',
  description: 'Echoes',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

describe('McpHttpServer', () => {
  it('initializes a session, lists and calls tools', async () => {
    const { post, server } = await start([echo]);
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(init.json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'oxytocin', version: '1.0.0' },
        instructions: 'Use cwd.',
      },
    });
    const session = String(init.headers['mcp-session-id']);
    expect(session).toMatch(/^[\w-]{20,}$/);
    expect(server.sessionCount).toBe(1);
    const s = { 'Mcp-Session-Id': session };
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, s)).status).toBe(202);
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, s);
    expect((list.json!['result'] as { tools: ListedTool[] }).tools).toEqual([echo]);
    const call = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } },
      s,
    );
    expect(call.json!['result']).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] });
    const failed = await post(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'fail' } } },
      s,
    );
    expect(failed.json!['result']).toEqual({ content: [{ type: 'text', text: 'It failed' }], isError: true });
    const unknown = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, s);
    expect(unknown.json!['error']).toEqual({ code: -32602, message: 'Unknown tool: nope' });
    const batch = await raw(server.port!, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', ...s },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 6, method: 'ping' },
        { jsonrpc: '2.0', id: 7, method: 'nope' },
      ]),
    });
    expect(JSON.parse(batch.body)).toEqual([
      { jsonrpc: '2.0', id: 6, result: {} },
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: nope' } },
    ]);
    expect(server.calls).toBe(2);
  });

  it('needs a session after initialize: 400 without one, 404 for an unknown one', async () => {
    const { post } = await start([echo]);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'Mcp-Session-Id': 'gone' })).status).toBe(
      404,
    );
  });

  it('checks token, Host and Origin on POST, GET and DELETE', async () => {
    const { port, initialize } = await start([echo]);
    const session = await initialize();
    const cases: [Record<string, string>, number][] = [
      [{ Authorization: 'Bearer wrong' }, 401],
      [{ Authorization: 'Bearer secret', Origin: 'https://evil.example' }, 403],
      [{ Authorization: 'Bearer secret', Host: 'evil.example:1234' }, 403],
    ];
    for (const method of ['POST', 'GET', 'DELETE']) {
      for (const [headers, status] of cases) {
        const r = await raw(port, {
          method,
          headers: { ...headers, 'Mcp-Session-Id': session, Accept: 'text/event-stream' },
          ...(method === 'POST' ? { body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' } : {}),
        });
        expect([method, r.status]).toEqual([method, status]);
      }
    }
    const local = await raw(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', Origin: 'http://localhost:3000', 'Mcp-Session-Id': session },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(local.status).toBe(200);
    expect((await raw(port, { method: 'POST', path: '/other' })).status).toBe(404);
    expect((await raw(port, { method: 'PUT', headers: { Authorization: 'Bearer secret' } })).status).toBe(405);
    const bad = await raw(port, { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{nope' });
    expect(bad.status).toBe(400);
    const version = await raw(port, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '1999-01-01' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(version.status).toBe(400);
  });

  it('streams list_changed notifications and heartbeats to the session, and ends it on DELETE', async () => {
    const { port, server, initialize } = await start([echo]);
    const session = await initialize();
    const received: string[] = [];
    const ended = new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': session, Accept: 'text/event-stream' },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.setEncoding('utf8');
          res.on('data', (c: string) => received.push(c));
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.end();
    });
    await expect.poll(() => received.join('')).toContain(': connected');
    expect(server.notifyToolsChanged()).toBe(1);
    await expect
      .poll(() => received.join(''))
      .toContain('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
    await expect.poll(() => received.join('')).toContain(': ping');
    const del = await raw(port, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': session },
    });
    expect(del.status).toBe(204);
    expect(await ended).toBe(200);
    expect(server.sessionCount).toBe(0);
  });

  it('aborts a call on notifications/cancelled', async () => {
    let signal: AbortSignal | undefined;
    const { post, initialize } = await start([echo], (_n, _a, call) => {
      signal = call.signal;
      return new Promise((resolve) =>
        call.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'stopped' }] })),
      );
    });
    const session = await initialize();
    const s = { 'Mcp-Session-Id': session, 'X-Oxytocin-Terminal': 't-1' };
    const pending = post({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'echo' } }, s);
    await expect.poll(() => signal).toBeDefined();
    await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' } }, s);
    expect((await pending).json!['result']).toEqual({ content: [{ type: 'text', text: 'stopped' }] });
    expect(signal!.aborted).toBe(true);
  });

  it('passes the terminal header, stops with open streams and reports a port in use', async () => {
    const { port, server, initialize, post, calls } = await start([echo]);
    const session = await initialize();
    await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } },
      { 'Mcp-Session-Id': session, 'X-Oxytocin-Terminal': 't-7' },
    );
    expect(calls[0]!.call.terminalHeader).toBe('t-7');
    request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': session, Accept: 'text/event-stream' },
    })
      .on('error', () => undefined)
      .end();
    await expect.poll(() => server.sessionCount).toBe(1);
    const other = new McpHttpServer(
      {
        info: () => ({ name: 'x', version: '1' }),
        listTools: () => [],
        hasTool: () => false,
        callTool: () => Promise.resolve({ content: [] }),
      },
      () => 's',
    );
    servers.push(other);
    await expect(other.start(port)).rejects.toThrow();
    expect(other.error).toMatch(/in use/);
    // Must not hang on the open stream.
    await server.stop();
    expect(server.sessionCount).toBe(0);
  });

  it('evicts the least recently used session when full', async () => {
    const server = new McpHttpServer(
      {
        info: () => ({ name: 'x', version: '1' }),
        listTools: () => [],
        hasTool: () => false,
        callTool: () => Promise.resolve({ content: [] }),
      },
      () => 'secret',
      { maxSessions: 2 },
    );
    servers.push(server);
    await server.start(0);
    const init = async () =>
      String(
        (
          await raw(server.port!, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
          })
        ).headers['mcp-session-id'],
      );
    const first = await init();
    await init();
    await init();
    expect(server.sessionCount).toBe(2);
    const r = await raw(server.port!, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': first },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(r.status).toBe(404);
  });

  it('guards against DNS rebinding', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedHost('127.0.0.1:47287')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('[::1]:1')).toBe(true);
    expect(isAllowedHost('evil.example:47287')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});
