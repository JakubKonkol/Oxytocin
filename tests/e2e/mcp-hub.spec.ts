import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { userDataWithPlugins } from './helpers/plugins';
import { waitForTerminal } from './helpers/terminal';
import { connect, freePort } from './helpers/mcp';

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
    // The server's settings are in its tab; the tools in a tab of their own.
    await expect(win.getByTestId('mcp-settings')).toContainText('Port');
    await expect(toolRow(win, 'oxy_read_terminal_output')).toHaveCount(0);
    await win.getByTestId('agent-tools-tab-tools').click();
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
    // The call log (its own tab) lists the calls without their arguments.
    await win.getByTestId('agent-tools-tab-calls').click();
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

test("Agent tools: Codex is connected through its config.toml, which keeps the user's settings", async () => {
  const port = await freePort();
  const codexHome = await mkdtemp(join(tmpdir(), 'oxy-e2e-codex-'));
  const config = join(codexHome, 'config.toml');
  await writeFile(config, '# mine\nmodel = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://figma.example"\n');
  const userData = await userDataWithPlugins([], { 'mcp.port': port });
  const { app, win } = await launchApp({
    userData,
    project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')),
    env: { CODEX_HOME: codexHome },
  });
  const codex = win.locator('[data-testid="mcp-client"][data-client="codex"]');
  try {
    await waitForTerminal(win);
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Settings' }).click();
    await win.locator('[data-testid="settings-section"][data-section="Agent Tools"]').click();
    await expect(win.getByTestId('mcp-status-text')).toContainText(`127.0.0.1:${port}/mcp`);
    await expect(codex).toHaveAttribute('data-connected', 'false');

    await win.getByTestId('mcp-connect-codex').click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Codex is connected' })).toBeVisible();
    await expect(codex).toHaveAttribute('data-connected', 'true');
    const { token } = JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string };
    const written = await readFile(config, 'utf8');
    expect(
      written.startsWith('# mine\nmodel = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://figma.example"\n\n'),
    ).toBe(true);
    expect(written).toContain('[mcp_servers.oxytocin]\n');
    expect(written).toContain(`url = "http://127.0.0.1:${port}/mcp"`);
    expect(written).toContain(`http_headers = { Authorization = "Bearer ${token}" }`);
    expect(written).toContain('env_http_headers = { X-Oxytocin-Terminal = "OXYTOCIN_TERMINAL_ID" }');
    // What Codex sends with that entry opens the server.
    const client = await connect(port, token);
    expect(await client.tools()).toContain('oxy_list_projects');
    client.close();

    await win.getByTestId('mcp-disconnect-codex').click();
    await expect(codex).toHaveAttribute('data-connected', 'false');
    expect(await readFile(config, 'utf8')).toBe(
      '# mine\nmodel = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://figma.example"\n',
    );
  } finally {
    await app.close();
  }
});
