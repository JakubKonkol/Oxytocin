import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { userDataWithPlugins } from './helpers/plugins';
import { waitForTerminal } from './helpers/terminal';

/** A free local port for the MCP server (another Oxytocin may use the default one). */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

interface Rpc {
  result?: { tools?: { name: string }[]; content?: { type: string; text: string }[]; isError?: boolean };
  error?: { message: string };
}

/** A minimal MCP client: one session, its SSE stream collected into `events`. */
async function connect(port: number, token: string) {
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
  const { session } = await post({
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

const pluginRow = (win: Page, id: string) => win.locator(`[data-testid="plugin-row"][data-plugin-id="${id}"]`);
const toolRow = (win: Page, name: string) => win.locator(`[data-testid="mcp-tool-row"][data-name="${name}"]`);

test('Agent tools: plugin tools reach connected agents live, can be turned off, and ask before destructive calls', async () => {
  const port = await freePort();
  const userData = await userDataWithPlugins(['mcp-tools'], {
    'mcp.port': port,
    'plugins.enabled': { 'test.mcp': false },
  });
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await waitForTerminal(win);
    // The token is created at start-up and kept in userData.
    await expect.poll(async () => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    client = await connect(port, token);
    expect(await client.tools()).toContain('oxy_list_projects');
    expect(await client.tools()).not.toContain('tests_echo');

    // Settings → Agent Tools shows the running server and the core tools.
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Settings' }).click();
    await win.locator('[data-testid="settings-section"][data-section="Agent Tools"]').click();
    await expect(win.getByTestId('mcp-status-text')).toContainText(`127.0.0.1:${port}/mcp`);
    await expect(win.getByTestId('mcp-status-detail')).toContainText('1 connected client');
    await expect(toolRow(win, 'oxy_read_terminal_output').getByTestId('mcp-tool-policy')).toHaveValue('ask');

    // Enabling the plugin in the plugin manager: the connected agent is told, and sees its tools.
    await win.getByTestId('status-plugins').click();
    await pluginRow(win, 'test.mcp').getByRole('button', { name: 'Enable' }).click();
    await expect.poll(() => client!.events.length).toBeGreaterThan(0);
    expect(client.events[0]).toBe('notifications/tools/list_changed');
    await expect
      .poll(() => client!.tools())
      .toEqual(expect.arrayContaining(['tests_echo', 'tests_reset', 'tests_wait']));
    expect((await client.call('tests_echo', { text: 'hi' })).result?.content?.[0]?.text).toBe('echo: hi');

    // Turning a tool off in the panel removes it for the agent.
    await win.getByTestId('tab-settings-editor').click();
    await expect(toolRow(win, 'tests_echo')).toBeVisible();
    const before = client.events.length;
    await toolRow(win, 'tests_echo').getByTestId('mcp-tool-enabled').click();
    await expect(toolRow(win, 'tests_echo')).toHaveAttribute('data-listed', 'false');
    await expect.poll(() => client!.events.length).toBeGreaterThan(before);
    await expect.poll(() => client!.tools()).not.toContain('tests_echo');

    // A destructive tool asks first; Deny returns an error to the agent.
    const denied = client.call('tests_reset');
    const dialog = win.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Allow Reset the test data?');
    await expect(dialog).toContainText('tests_reset');
    await dialog.getByRole('button', { name: 'Deny' }).click();
    expect((await denied).result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The user did not allow tests_reset this time.' }],
    });
    // "Always allow" runs it and remembers the choice.
    const allowed = client.call('tests_reset');
    await win.getByTestId('confirm-dialog-secondary').click();
    expect((await allowed).result?.content?.[0]?.text).toBe('reset done');
    await expect(toolRow(win, 'tests_reset').getByTestId('mcp-tool-policy')).toHaveValue('allow');
    // The call log lists the calls without their arguments.
    await expect(
      win.locator('[data-testid="mcp-log-row"][data-tool="tests_reset"][data-outcome="denied"]'),
    ).toHaveCount(1);
    await expect(win.locator('[data-testid="mcp-log-row"][data-tool="tests_reset"][data-outcome="ok"]')).toHaveCount(1);

    // An agent's question shows an in-app dialog; the answer goes back to the agent.
    const asked = client.call('oxy_ask_user', { question: 'Deploy now?', options: ['Yes', 'Later'] });
    await expect(dialog).toContainText('Deploy now?');
    await dialog.getByTestId('dialog-option').filter({ hasText: 'Later' }).click();
    await dialog.getByRole('button', { name: 'Answer' }).click();
    expect((await asked).result?.content?.[0]?.text).toBe('The user answered: Later');
  } finally {
    client?.close();
    await app.close();
  }
});

test('Agent tools: the server follows mcp.enabled and reports a port in use', async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  const userData = await userDataWithPlugins([], { 'mcp.port': port });
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    await waitForTerminal(win);
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Settings' }).click();
    await win.locator('[data-testid="settings-section"][data-section="Agent Tools"]').click();
    await expect(win.getByTestId('mcp-status-text')).toContainText(`Port ${port} is in use`);
    // Another port: it starts there.
    const next = await freePort();
    await win.evaluate((p) => window.oxy.invoke('settings:update', { 'mcp.port': p }), next);
    await expect(win.getByTestId('mcp-status-text')).toContainText(`127.0.0.1:${next}/mcp`);
    expect((await fetch(`http://127.0.0.1:${next}/mcp`, { method: 'POST' })).status).toBe(401);
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'mcp.enabled': false }));
    await expect(win.getByTestId('mcp-status-text')).toHaveText('MCP server turned off');
    await expect(fetch(`http://127.0.0.1:${next}/mcp`, { method: 'POST' })).rejects.toThrow();
  } finally {
    await app.close();
    blocker.close();
  }
});
