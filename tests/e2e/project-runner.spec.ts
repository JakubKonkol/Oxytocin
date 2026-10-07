import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { defaultUiState } from '../../src/shared/domain/ui-state';
import { launchApp } from './helpers/launch';
import { activeProjectId, oxyTest, waitForTerminal } from './helpers/terminal';

const MCP_PORT = 47392;
const LEGACY_PORT = 47393;

/** A dev server that prints its URL like Vite and keeps running until interrupted. */
const SERVER = `const http = require('http');
const server = http.createServer((req, res) => res.end('hello from demo'));
server.listen(0, '127.0.0.1', () => {
  console.log('\\n  \\x1b[32m➜\\x1b[0m  Local:   http://localhost:' + server.address().port + '/');
});
process.on('SIGINT', () => { console.log('bye'); process.exit(0); });
`;

/**
 * A `claude` command that records its arguments and knows the servers added and not removed since (the log starts
 * with an old `oxytocin-runner` registration).
 */
async function fakeClaude(dir: string): Promise<{ command: string; log: string }> {
  const log = join(dir, 'claude.log');
  const script = join(dir, 'fake-claude.cjs');
  await writeFile(
    log,
    JSON.stringify(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'oxytocin-runner', 'http://old']) + '\n',
  );
  await writeFile(
    script,
    `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const servers = {};
for (const line of fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(Boolean)) {
  const a = JSON.parse(line);
  if (a[1] === 'add') servers[a[6]] = a[7];
  if (a[1] === 'remove') delete servers[a[a.length - 1]];
}
if (args[0] === 'mcp' && args[1] === 'get') {
  const name = args[2];
  if (!servers[name]) { console.error('No MCP server found with name: ' + name); process.exit(1); }
  console.log(name + ':\\n  Type: http\\n  URL: ' + servers[name]);
  process.exit(0);
}
console.log('ok');
`,
  );
  if (process.platform === 'win32') {
    const command = join(dir, 'claude.cmd');
    await writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
    return { command, log };
  }
  const command = join(dir, 'claude');
  await writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(command, 0o755);
  return { command, log };
}

/**
 * The Run tool is not shown until it is added to a sidebar: these tests start with it in the left sidebar (where it
 * used to be) and the right sidebar closed, so terminals keep their width on small CI screens.
 */
async function withRunInLeftSidebar(userData: string): Promise<void> {
  const ui = defaultUiState();
  ui.secondarySidebar.collapsed = true;
  ui.primaryTools = [
    {
      id: 'tool-run',
      kind: 'plugin',
      pluginId: 'oxytocin.project-runner',
      panelType: 'projectRunner.panel',
      viewId: 'pv-run',
      title: 'Run',
    },
  ];
  await writeFile(join(userData, 'ui-state.json'), JSON.stringify(ui));
}

const uiTools = (win: Page) =>
  win.evaluate(() => window.oxy.invoke('ui:getState')) as Promise<{
    primaryTools: { id: string; panelType?: string }[];
    secondaryTools: { id: string; panelType?: string }[];
  }>;

async function runnerFrame(win: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const f of win.frames()) {
          if (!f.url().startsWith('oxy-plugin://oxytocin.project-runner/') || f.isDetached()) continue;
          if (
            await f
              .getByTestId('runner')
              .count()
              .catch(() => 0)
          )
            found = f;
        }
        return !!found;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

/** A JSON-RPC call to an MCP server; `session` is sent as Mcp-Session-Id and updated from the response. */
async function mcp(
  o: { port: number; token: string; session?: { id?: string } },
  method: string,
  params?: unknown,
): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetch(`http://127.0.0.1:${o.port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${o.token}`,
      ...(o.session?.id ? { 'Mcp-Session-Id': o.session.id } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  const id = res.headers.get('mcp-session-id');
  if (o.session && id) o.session.id = id;
  return (await res.json()) as { result?: unknown; error?: unknown };
}

const toolText = (r: { result?: unknown }) => (r.result as { content: { text: string }[] }).content[0]!.text;

test("Project Runner: detects apps, runs them in background terminals, edits profiles and serves agents through Oxytocin's MCP server", async () => {
  test.setTimeout(150_000);
  const work = await mkdtemp(join(tmpdir(), 'oxy-e2e-runner-'));
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'demo-web', scripts: { dev: 'node server.js' }, dependencies: { express: '5' } }),
  );
  await writeFile(join(project, 'package-lock.json'), '{}');
  await writeFile(join(project, 'server.js'), SERVER);
  const claude = await fakeClaude(work);
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'mcp.port': MCP_PORT, 'mcp.claudeCommand': claude.command }),
  );
  await withRunInLeftSidebar(userData);
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    const t = oxyTest(win);
    const frame = await runnerFrame(win);
    const row = frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]');
    await expect(row).toContainText('demo-web');
    await expect(row).toContainText('Node.js server');
    await expect(row).toContainText('npm run dev');

    // Run: a background terminal (no new panel), running once the URL is printed.
    await row.getByTestId('runner-start').click();
    await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect(row.getByTestId('runner-url')).toHaveText(/^localhost:\d+\/$/);
    expect((await t.workspace())!.panels).toHaveLength(1);
    await expect(win.getByTestId('status-item-projectRunner.status')).toContainText('1 running');

    // Logs: the terminal gets a panel with the server output.
    await row.getByTestId('runner-logs').click();
    await expect.poll(async () => (await t.workspace())!.panels.length).toBe(2);
    const runTerminal = (await t.workspace())!.panels.find((p) => p.terminalId && p.id !== undefined)!;
    const ids = (await t.workspace())!.panels.map((p) => p.terminalId).filter(Boolean) as string[];
    let serverOutput = '';
    await expect
      .poll(async () => {
        for (const id of ids) {
          const text = await t.text(id);
          if (text.includes('Local:')) serverOutput = text;
        }
        return serverOutput;
      })
      .toContain('Local:   http://localhost:');
    expect(runTerminal).toBeTruthy();

    // Stop: Ctrl+C ends the server, the shell stays for the next run.
    await row.getByTestId('runner-stop').click();
    await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
    await expect(win.getByTestId('status-item-projectRunner.status')).toHaveCount(0);

    // A custom profile from the form ("+" → Run Profile…).
    await frame.getByTestId('runner-add').click();
    await win.getByTestId('plugin-context-menu').getByRole('menuitem', { name: 'Run Profile…' }).click();
    await frame.getByTestId('runner-form-name').fill('worker');
    await frame.getByTestId('runner-form-command').fill('node -e "setInterval(() => {}, 1000)"');
    await frame.getByTestId('runner-form-cwd').fill('../outside');
    await frame.getByTestId('runner-form-save').click();
    await expect(frame.getByTestId('runner-form-error')).toContainText('relative to the project root');
    await frame.getByTestId('runner-form-cwd').fill('');
    await frame.getByTestId('runner-form-env').fill('WORKER_MODE=1');
    await frame.getByTestId('runner-form-save').click();
    const worker = frame.locator('[data-testid="runner-profile"]').filter({ hasText: 'worker' });
    await expect(worker).toBeVisible();

    // MCP: an agent lists the profiles and starts one through Oxytocin's server; the panel shows it as started by an
    // agent. No old server runs on a new install.
    expect(
      await readFile(join(userData, 'plugin-data/oxytocin.project-runner/storage.json'), 'utf8').catch(() => ''),
    ).not.toContain('mcpToken');
    await expect.poll(() => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const { token } = JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string };
    const hub = { port: MCP_PORT, token, session: {} as { id?: string } };
    expect(
      ((await mcp(hub, 'initialize', { protocolVersion: '2025-06-18' })).result as { serverInfo: unknown }).serverInfo,
    ).toMatchObject({ name: 'oxytocin' });
    const tools = (await mcp(hub, 'tools/list')).result as { tools: { name: string }[] };
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['run_list_profiles', 'run_start_profile']));
    const listed = toolText(await mcp(hub, 'tools/call', { name: 'run_list_profiles', arguments: { cwd: project } }));
    expect(listed).toContain('"name": "demo-web"');
    expect(listed).toContain('"name": "worker"');
    const started = toolText(
      await mcp(hub, 'tools/call', {
        name: 'run_start_profile',
        arguments: { profile: 'demo-web', cwd: project, wait_seconds: 30 },
      }),
    );
    expect(started).toContain('"status": "running"');
    expect(started).toMatch(/"url": "http:\/\/localhost:\d+\/"/);
    const url = /"url": "(http:\/\/localhost:\d+\/)"/.exec(started)![1]!;
    expect(await (await fetch(url)).text()).toBe('hello from demo');
    // A project API whose base URL is this run profile's URL reaches the running app.
    await win.evaluate(
      (id) =>
        window.oxy.invoke('resources:save', {
          projectId: id,
          resources: { apis: [{ id: 'web', name: 'web', baseUrl: { runProfileId: 'node:' } }] },
        }),
      await activeProjectId(win),
    );
    const viaApi = toolText(
      await mcp(hub, 'tools/call', {
        name: 'oxy_api_request',
        arguments: { project: basename(project), api: 'web', method: 'GET', path: '/' },
      }),
    );
    expect(viaApi).toContain('hello from demo');
    await expect(row).toHaveAttribute('data-status', 'running');
    await expect(row.getByTestId('runner-agent-badge')).toBeVisible();
    // Without `cwd`: the active project.
    const logs = toolText(await mcp(hub, 'tools/call', { name: 'run_get_logs', arguments: { profile: 'demo-web' } }));
    expect(logs).toContain('Local:   http://localhost:');
    const stopped = toolText(
      await mcp(hub, 'tools/call', { name: 'run_stop_profile', arguments: { profile: 'demo-web', cwd: project } }),
    );
    expect(stopped).toContain('"status": "stopped"');
    await expect(row).toHaveAttribute('data-status', 'stopped');

    // "Agent Tools" in the Run tool opens the settings, where Claude Code is connected; the old registration goes.
    await frame.getByTestId('runner-agent-tools').click();
    await expect(win.getByTestId('agent-tools')).toBeVisible();
    await expect(win.getByTestId('mcp-status-detail')).toContainText('not connected to Claude Code');
    await win.getByTestId('mcp-connect').click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Claude Code is connected' })).toContainText(
      'oxytocin-runner',
    );
    await expect(win.getByTestId('mcp-status-detail')).toContainText('connected to Claude Code');
    const calls = (await readFile(claude.log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toContainEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'oxytocin',
      `http://127.0.0.1:${MCP_PORT}/mcp`,
      '--header',
      `Authorization: Bearer ${token}`,
      '--header',
      'X-Oxytocin-Terminal: ${OXYTOCIN_TERMINAL_ID:-none}',
    ]);
    expect(calls).toContainEqual(['mcp', 'remove', '--scope', 'user', 'oxytocin-runner']);
  } finally {
    await app.close();
  }

  // Profiles are kept: after a restart the custom profile is still there.
  const again = await launchApp({ userData });
  try {
    await expect(again.win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    const frame = await runnerFrame(again.win);
    await expect(frame.locator('[data-testid="runner-profile"]').filter({ hasText: 'worker' })).toBeVisible();
    await expect(frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]')).toHaveAttribute(
      'data-status',
      'idle',
    );
  } finally {
    await again.app.close();
  }
});

test('Project Runner: custom scripts — a script file of the project in a new terminal tab, hidden from agents, and a written script', async () => {
  test.setTimeout(150_000);
  const win32 = process.platform === 'win32';
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'demo-web', scripts: { dev: 'node server.js' } }),
  );
  await writeFile(join(project, 'package-lock.json'), '{}');
  await writeFile(join(project, 'server.js'), SERVER);
  await mkdir(join(project, 'tools'));
  // A script that ends with PAUSE (cmd) or its bash twin: it waits for a key after its work.
  const scriptName = win32 ? 'hello.bat' : 'hello.sh';
  await writeFile(
    join(project, 'tools', scriptName),
    win32
      ? '@echo off\r\necho Hello from the script in %CD%\r\npause\r\n'
      : 'echo "Hello from the script in $PWD"\nread -n 1 -s -r -p "Press any key to continue . . . "\necho\n',
  );
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const port = MCP_PORT + 3;
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'mcp.port': port, 'projectRunner.mcp.enabled': false }),
  );
  await withRunInLeftSidebar(userData);
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    const t = oxyTest(win);
    const frame = await runnerFrame(win);
    const detected = frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]');
    await expect(detected).toContainText('demo-web');
    const panels = async () => (await t.workspace())!.panels.length;
    expect(await panels()).toBe(1);

    // "+" → Custom Script…: the script file is chosen from the project's scripts.
    await frame.getByTestId('runner-add').click();
    await win.getByTestId('plugin-context-menu').getByRole('menuitem', { name: 'Custom Script…' }).click();
    await expect(frame.getByTestId('runner-script-form')).toBeVisible();
    await frame.getByTestId('runner-script-choose').click();
    await win.getByTestId('command-palette-item').filter({ hasText: scriptName }).click();
    await expect(frame.getByTestId('runner-script-file')).toHaveValue(`tools/${scriptName}`);
    await expect(frame.getByTestId('runner-script-name')).toHaveValue('hello');
    await frame.getByTestId('runner-script-name').fill('Say hello');
    await frame.getByTestId('runner-script-new-terminal').check();
    await expect(frame.getByTestId('runner-script-agents')).toBeChecked();
    await frame.getByTestId('runner-script-agents').uncheck();
    await frame.getByTestId('runner-form-save').click();

    // The detected profile stays; the script is listed below it.
    const rows = frame.getByTestId('runner-profile');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-profile-id', 'node:');
    const hello = rows.nth(1);
    await expect(hello).toContainText('Say hello');
    await expect(hello).toContainText(`tools/${scriptName}`);
    await expect(hello.getByTestId('runner-tag-new-terminal')).toBeVisible();
    await expect(hello.getByTestId('runner-tag-no-agents')).toBeVisible();

    // Run: a new terminal tab opens and shows the script's output (run in the script's folder); PAUSE shows
    // "Continue".
    await hello.getByTestId('runner-start').click();
    await expect.poll(panels, { timeout: 20_000 }).toBe(2);
    await expect(hello).toHaveAttribute('data-prompt', 'true', { timeout: 30_000 });
    await expect(frame.getByTestId('runner-prompt-text')).toHaveText('Press any key to continue . . .');
    const runTerminal = (await t.workspace())!.panels
      .map((p) => p.terminalId)
      .filter(Boolean)
      .at(-1)!;
    expect(await t.text(runTerminal)).toMatch(/Hello from the script in .*tools/);
    await frame.getByTestId('runner-prompt-continue').click();
    await expect(hello).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
    // Again: another new tab (the first one stays open).
    await hello.getByTestId('runner-start').click();
    await expect.poll(panels, { timeout: 20_000 }).toBe(3);
    await expect(hello).toHaveAttribute('data-prompt', 'true', { timeout: 30_000 });
    await frame.getByTestId('runner-prompt-continue').click();
    await expect(hello).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });

    // A written script (visible to agents, run in the background).
    await frame.getByTestId('runner-add').click();
    await win.getByTestId('plugin-context-menu').getByRole('menuitem', { name: 'Custom Script…' }).click();
    await frame.getByTestId('runner-script-name').fill('inline');
    await frame.getByTestId('runner-script-source-inline').check();
    await expect(frame.getByTestId('runner-script-language')).toHaveValue(win32 ? 'cmd' : 'sh');
    await frame.getByTestId('runner-script-inline').fill(win32 ? '@echo off\necho inline-ok' : 'echo inline-ok');
    await frame.getByTestId('runner-form-save').click();
    const inline = rows.filter({ hasText: 'inline' });
    await expect(inline).toContainText(win32 ? 'written batch script' : 'written shell script');
    await inline.getByTestId('runner-start').click();
    await expect(inline).toHaveAttribute('data-status', 'stopped', { timeout: 30_000 });
    expect(await panels()).toBe(3);

    // Agents see the written script, not the one hidden from them.
    await expect.poll(() => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const { token } = JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string };
    const hub = { port, token, session: {} as { id?: string } };
    await mcp(hub, 'initialize', { protocolVersion: '2025-06-18' });
    const listed = toolText(await mcp(hub, 'tools/call', { name: 'run_list_profiles', arguments: { cwd: project } }));
    expect(listed).toContain('"name": "demo-web"');
    expect(listed).toContain('"name": "inline"');
    expect(listed).not.toContain('Say hello');
    const logs = toolText(await mcp(hub, 'tools/call', { name: 'run_get_logs', arguments: { profile: 'inline' } }));
    expect(logs).toContain('inline-ok');
    const refused = await mcp(hub, 'tools/call', { name: 'run_start_profile', arguments: { profile: 'Say hello' } });
    expect(JSON.stringify(refused)).toContain('No run profile');

    // Edit: the script form comes back with the saved options.
    await hello.getByTestId('runner-more').click();
    await win.getByTestId('plugin-context-menu').getByRole('menuitem', { name: 'Edit…' }).click();
    await expect(frame.getByTestId('runner-script-file')).toHaveValue(`tools/${scriptName}`);
    await expect(frame.getByTestId('runner-script-new-terminal')).toBeChecked();
    await expect(frame.getByTestId('runner-script-agents')).not.toBeChecked();
  } finally {
    await app.close();
  }
});

/** Asks like `ng serve` when its port is taken, then serves; exits with 1 on Ctrl+C (like the Angular CLI). */
const ASKING_SERVER = `const http = require('http');
const readline = require('readline');
process.on('SIGINT', () => process.exit(1));
process.stdout.write('\\x1b[32m?\\x1b[39m Port 4200 is already in use.\\nWould you like to use a different port? (Y/n) ');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (answer) => {
  rl.close();
  if (/^n/i.test(answer)) { console.log('Aborted.'); process.exit(1); }
  const server = http.createServer((req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1', () => console.log('  Local:   http://localhost:' + server.address().port + '/'));
});
`;

test('Project Runner: a question of a starting app is asked once, in the Run view or a toast; stopping it is no failure', async () => {
  test.setTimeout(120_000);
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'asking', scripts: { dev: 'node ask.js' } }));
  await writeFile(join(project, 'package-lock.json'), '{}');
  await writeFile(join(project, 'ask.js'), ASKING_SERVER);
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    // A stopped command would report "Command failed (exit 1)" after a second.
    JSON.stringify({ 'projectRunner.mcp.enabled': false, 'notifications.commandFinishedMinSeconds': 1 }),
  );
  await withRunInLeftSidebar(userData);
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    const runHeader = win.getByTestId('sidebar').getByTestId('section-header-tool-run');
    // Collapsing the Run section and expanding it again can mount a new frame: look it up again each time.
    let frame = await runnerFrame(win);
    const row = () => frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]');
    const prompt = () => frame.getByTestId('runner-prompt');
    const expandRun = async () => {
      await runHeader.click();
      frame = await runnerFrame(win);
    };
    const status = win.getByTestId('status-item-projectRunner.status');
    const toast = win.locator('[data-sonner-toast]').filter({ hasText: 'is waiting for your answer' });
    const stop = async () => {
      await row().getByTestId('runner-stop').click();
      await expect(row()).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
    };
    /** Starts the app from the command palette (the Run view may be collapsed). */
    const startFromPalette = async () => {
      void win
        .evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'projectRunner.run' }))
        .catch(() => undefined);
      await expect(win.getByTestId('command-palette-item').first()).toBeVisible();
      await win.keyboard.press('Enter');
    };

    // 1. The Run view is on screen: it shows the question (and the status bar), no toast repeats it.
    await row().getByTestId('runner-start').click();
    await expect(row()).toHaveAttribute('data-prompt', 'true', { timeout: 30_000 });
    await expect(row().getByTestId('runner-status')).toHaveText('waiting for input');
    await expect(prompt().getByTestId('runner-prompt-text')).toHaveText(
      'Port 4200 is already in use.\nWould you like to use a different port? (Y/n)',
    );
    await expect(status).toContainText('waiting for input');
    await win.waitForTimeout(1000);
    await expect(toast).toHaveCount(0);
    await prompt().getByTestId('runner-prompt-yes').click();
    await expect(row()).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
    await expect(prompt()).toHaveCount(0);
    await expect(row().getByTestId('runner-url')).toHaveText(/^localhost:\d+\/$/);
    // Stop: the app exits with 1 on Ctrl+C, which is a stop, not a failure.
    await win.waitForTimeout(1200);
    await stop();
    await win.waitForTimeout(1500);
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Command failed' })).toHaveCount(0);

    // 2. The Run view is collapsed: a toast asks, and its answer reaches the app.
    await runHeader.click();
    await startFromPalette();
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(toast.getByTestId('toast-action-show')).toBeVisible();
    await toast.getByTestId('toast-action-yes').click();
    await expect(toast).toHaveCount(0);
    await expect(status).toContainText('1 running', { timeout: 20_000 });
    await expect(status).not.toContainText('waiting for input', { timeout: 20_000 });
    await expandRun();
    await expect(row()).toHaveAttribute('data-status', 'running');
    await stop();

    // 3. The toast asks, then the Run view is shown: the toast closes and the view asks.
    await runHeader.click();
    await startFromPalette();
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expandRun();
    await expect(toast).toHaveCount(0);
    await expect(row()).toHaveAttribute('data-prompt', 'true');
    await prompt().getByTestId('runner-prompt-yes').click();
    await expect(row()).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
    await win.waitForTimeout(500);
    await expect(toast).toHaveCount(0);
    await win.waitForTimeout(1200);
    await stop();
  } finally {
    await app.close();
  }
});

test('Project Runner: the old oxytocin-runner server keeps working where it was used, and can be turned off', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  // An install from before 0.6.5: the runner created a token for its own server.
  await mkdir(join(userData, 'plugin-data/oxytocin.project-runner'), { recursive: true });
  await writeFile(
    join(userData, 'plugin-data/oxytocin.project-runner/storage.json'),
    JSON.stringify({ mcpToken: 'old-token-0123456789' }),
  );
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'projectRunner.mcp.port': LEGACY_PORT, 'mcp.port': MCP_PORT }),
  );
  await withRunInLeftSidebar(userData);
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    await runnerFrame(win);
    const legacy = { port: LEGACY_PORT, token: 'old-token-0123456789' };
    await expect
      .poll(async () =>
        (
          (await mcp(legacy, 'tools/list').catch(() => ({ result: { tools: [] } }))).result as {
            tools: { name: string }[];
          }
        ).tools.map((t) => t.name),
      )
      .toContain('list_run_profiles');
    const listed = toolText(
      await mcp(legacy, 'tools/call', { name: 'list_run_profiles', arguments: { cwd: project } }),
    );
    expect(listed).toContain('"profiles"');
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'projectRunner.mcp.enabled': false }));
    await expect
      .poll(() =>
        fetch(`http://127.0.0.1:${LEGACY_PORT}/mcp`, { method: 'POST' }).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
  } finally {
    await app.close();
  }
});

test('Run is added to the right sidebar, keeps its menus on screen and moves between the sidebars', async () => {
  test.setTimeout(120_000);
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo-web', scripts: { dev: 'node s.js' } }));
  await writeFile(join(project, 'package-lock.json'), '{}');
  const first = await launchApp({ project, secondarySidebar: true });
  const { userData } = first;
  let toolId = '';
  try {
    const { win } = first;
    await waitForTerminal(win);
    const left = win.getByTestId('sidebar');
    const right = win.getByTestId('secondary-sidebar');
    // Not shown until added: no Run section in the left sidebar, no Run tool anywhere.
    await expect(left.getByTestId('section-header-plugin:oxytocin.project-runner:projectRunner.sidebar')).toHaveCount(
      0,
    );
    await expect(win.getByTestId('sidebar-tool-projectRunner.panel')).toHaveCount(0);

    // "Add tool" of the right sidebar → Run.
    await right.getByTestId('section-header-scratchpad').hover();
    await right.getByTestId('add-tool-below-scratchpad').click();
    await win.getByTestId('sidebar-add-tool-menu').getByTestId('add-tool-plugin:projectRunner.panel').click();
    await expect(right.getByTestId('sidebar-tool-projectRunner.panel')).toBeVisible();
    let frame = await runnerFrame(win);
    const row = () => frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]');
    await expect(row()).toContainText('demo-web');

    // "More actions" at the right edge of the window: the menu opens to the left, fully on screen.
    await row().getByTestId('runner-more').click();
    const menu = win.getByTestId('plugin-context-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // "Move to left sidebar".
    // ui-state.json is written with a short delay.
    await expect
      .poll(
        async () =>
          (toolId = (await uiTools(win)).secondaryTools.find((t) => t.panelType === 'projectRunner.panel')?.id ?? ''),
      )
      .not.toBe('');
    await right.getByTestId(`section-header-${toolId}`).hover();
    await right.getByTestId(`move-tool-side-${toolId}`).click();
    await expect(left.getByTestId('sidebar-tool-projectRunner.panel')).toBeVisible();
    await expect(right.getByTestId('sidebar-tool-projectRunner.panel')).toHaveCount(0);
    await expect
      .poll(async () => (await uiTools(win)).primaryTools.map((t) => t.panelType))
      .toEqual(['projectRunner.panel']);
    toolId = (await uiTools(win)).primaryTools[0]!.id;
    frame = await runnerFrame(win);
    await expect(row()).toContainText('demo-web');
  } finally {
    await first.app.close();
  }

  // It stays in the left sidebar after a restart; its section header drags it back to the right sidebar.
  const again = await launchApp({ userData });
  try {
    const { win } = again;
    await expect(win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    const left = win.getByTestId('sidebar');
    const right = win.getByTestId('secondary-sidebar');
    await expect(left.getByTestId('sidebar-tool-projectRunner.panel')).toBeVisible();
    const frame = await runnerFrame(win);
    await expect(frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]')).toContainText('demo-web');
    const target = right.getByTestId('scratchpad-input');
    const box = (await target.boundingBox())!;
    await left
      .getByTestId(`section-header-${toolId}`)
      .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 10 } });
    await expect(right.getByTestId('sidebar-tool-projectRunner.panel')).toBeVisible();
    await expect(left.getByTestId('sidebar-tool-projectRunner.panel')).toHaveCount(0);
    await expect
      .poll(async () => (await uiTools(win)).secondaryTools.map((t) => t.panelType ?? 'scratchpad'))
      .toEqual(['scratchpad', 'projectRunner.panel']);
  } finally {
    await again.app.close();
  }
});
