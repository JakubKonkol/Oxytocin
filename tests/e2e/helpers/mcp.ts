import { createServer, request } from 'node:http';

/** A free local port for the MCP server (another Oxytocin may use the default one). */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export interface Rpc {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
    instructions?: string;
  };
  error?: { message: string };
}

/** A minimal MCP client: one session, its SSE stream collected into `events`. */
export async function connect(port: number, token: string, extraHeaders: Record<string, string> = {}) {
  const post = (body: unknown, session?: string) =>
    new Promise<{ session: string; json: Rpc }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(session ? { 'Mcp-Session-Id': session } : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('end', () =>
            resolve({
              session: String(res.headers['mcp-session-id'] ?? ''),
              json: (text ? JSON.parse(text) : {}) as Rpc,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const { session, json: init } = await post({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  const events: string[] = [];
  const stream = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': session },
  });
  stream.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      for (const line of chunk.split('\n'))
        if (line.startsWith('data: ')) events.push((JSON.parse(line.slice(6)) as { method: string }).method);
    });
  });
  stream.on('error', () => undefined);
  stream.end();
  let id = 1;
  return {
    instructions: init.result?.instructions ?? '',
    events,
    tools: async () =>
      ((await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list' }, session)).json.result?.tools ?? []).map(
        (t) => t.name,
      ),
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, session)).json,
    close: () => stream.destroy(),
  };
}
