import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedHost, isAllowedOrigin, McpServer } from './mcp';

const servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function startServer() {
  const server = new McpServer({ name: 'test', version: '1.0.0', instructions: 'Use cwd.' }, () => 'secret');
  server.setTools([
    {
      name: 'echo',
      description: 'Echoes',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      handler: (args) =>
        args['text'] === 'fail'
          ? Promise.reject(new Error('It failed'))
          : Promise.resolve(`echo: ${String(args['text'])}`),
    },
  ]);
  servers.push(server);
  // Port 0: any free port; read it back from the server.
  await server.start(0);
  const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret', ...headers },
      body: JSON.stringify(body),
    });
  return { server, port, post };
}

describe('McpServer', () => {
  it('initializes, lists and calls tools', async () => {
    const { post } = await startServer();
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(await init.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test', version: '1.0.0' },
        instructions: 'Use cwd.',
      },
    });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo']);
    const call = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(await call.json()).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'echo: hi' }] },
    });
    const failed = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'fail' } },
    });
    expect(((await failed.json()) as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: 'It failed' }],
      isError: true,
    });
    const batch = await post([
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      { jsonrpc: '2.0', id: 6, method: 'nope' },
    ]);
    expect(await batch.json()).toEqual([
      { jsonrpc: '2.0', id: 5, result: {} },
      { jsonrpc: '2.0', id: 6, error: { code: -32601, message: 'Method not found: nope' } },
    ]);
  });

  it('rejects requests without the token, from foreign origins and other methods', async () => {
    const { post, port } = await startServer();
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:3000' })).status).toBe(
      200,
    );
    const get = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: 'Bearer secret' } });
    expect(get.status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' })).status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
  });

  it('reports a port in use', async () => {
    const { port } = await startServer();
    const other = new McpServer({ name: 'x', version: '1' }, () => 's');
    servers.push(other);
    await expect(other.start(port)).rejects.toThrow();
    expect(other.error).toMatch(/in use/);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedHost('127.0.0.1:47286')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('evil.example:47286')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
  });
});
