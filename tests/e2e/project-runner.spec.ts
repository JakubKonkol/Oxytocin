import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

const MCP_PORT = 47392;

/** A dev server that prints its URL like Vite and keeps running until interrupted. */
const SERVER = `const http = require('http');
const server = http.createServer((req, res) => res.end('hello from demo'));
server.listen(0, '127.0.0.1', () => {
  console.log('\\n  \\x1b[32m➜\\x1b[0m  Local:   http://localhost:' + server.address().port + '/');
});
process.on('SIGINT', () => { console.log('bye'); process.exit(0); });
`;

/** A `claude` command that records its arguments ("mcp get" fails until "mcp add" ran). */
async function fakeClaude(dir: string): Promise<{ command: string; log: string }> {
  const log = join(dir, 'claude.log');
  const script = join(dir, 'fake-claude.cjs');
  await writeFile(
    script,
    `const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const added = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((l) => l.includes('"add"')).pop();
if (args[0] === 'mcp' && args[1] === 'get') {
  if (!added) { console.error('No MCP server found with name: oxytocin-runner'); process.exit(1); }
  console.log('oxytocin-runner:\\n  Type: http\\n  URL: ' + JSON.parse(added)[7]);
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

async function mcp(token: string, method: string, params?: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await res.json()) as { result?: unknown; error?: unknown };
}

const toolText = (r: { result?: unknown }) => (r.result as { content: { text: string }[] }).content[0]!.text;

test('Project Runner: detects apps, runs them in background terminals, edits profiles and serves agents over MCP', async () => {
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
    JSON.stringify({ 'projectRunner.mcp.port': MCP_PORT, 'projectRunner.claudeCommand': claude.command }),
  );
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

    // A custom profile from the form.
    await frame.getByTestId('runner-add').click();
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

    // MCP: an agent lists the profiles and starts one; the panel shows it as started by an agent.
    const storage = join(userData, 'plugin-data/oxytocin.project-runner/storage.json');
    await expect.poll(() => readFile(storage, 'utf8').catch(() => '')).toContain('mcpToken');
    const { mcpToken: token } = JSON.parse(await readFile(storage, 'utf8')) as { mcpToken: string };
    expect(
      ((await mcp(token, 'initialize', { protocolVersion: '2025-06-18' })).result as { serverInfo: unknown })
        .serverInfo,
    ).toMatchObject({ name: 'oxytocin-runner' });
    const listed = toolText(await mcp(token, 'tools/call', { name: 'list_run_profiles', arguments: { cwd: project } }));
    expect(listed).toContain('"name": "demo-web"');
    expect(listed).toContain('"name": "worker"');
    const started = toolText(
      await mcp(token, 'tools/call', {
        name: 'start_run_profile',
        arguments: { profile: 'demo-web', cwd: project, wait_seconds: 30 },
      }),
    );
    expect(started).toContain('"status": "running"');
    expect(started).toMatch(/"url": "http:\/\/localhost:\d+\/"/);
    const url = /"url": "(http:\/\/localhost:\d+\/)"/.exec(started)![1]!;
    expect(await (await fetch(url)).text()).toBe('hello from demo');
    await expect(row).toHaveAttribute('data-status', 'running');
    await expect(row.getByTestId('runner-agent-badge')).toBeVisible();
    const logs = toolText(
      await mcp(token, 'tools/call', { name: 'get_run_logs', arguments: { profile: 'demo-web', cwd: project } }),
    );
    expect(logs).toContain('Local:   http://localhost:');
    const stopped = toolText(
      await mcp(token, 'tools/call', { name: 'stop_run_profile', arguments: { profile: 'demo-web', cwd: project } }),
    );
    expect(stopped).toContain('"status": "stopped"');
    await expect(row).toHaveAttribute('data-status', 'stopped');
    // Wrong token: rejected.
    const denied = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(denied.status).toBe(401);

    // Connect Claude Code registers the server with `claude mcp add`.
    await frame.getByTestId('runner-connect-claude').click();
    await expect(frame.getByTestId('runner-mcp')).toContainText('Claude Code ✓');
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
      'oxytocin-runner',
      `http://127.0.0.1:${MCP_PORT}/mcp`,
      '--header',
      `Authorization: Bearer ${token}`,
    ]);
  } finally {
    await app.close();
  }

  // Profiles are kept: after a restart the custom profile is still there.
  const again = await launchApp({ userData });
  try {
    await expect(again.win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    const frame = await runnerFrame(again.win);
    await expect(frame.locator('[data-testid="runner-profile"]').filter({ hasText: 'worker' })).toBeVisible();
    // Claude Code still has the server at this port.
    await expect(frame.getByTestId('runner-mcp')).toContainText('Claude Code ✓');
    await expect(frame.locator('[data-testid="runner-profile"][data-profile-id="node:"]')).toHaveAttribute(
      'data-status',
      'idle',
    );
  } finally {
    await again.app.close();
  }
});

test('Project Runner: the MCP server can be turned off in the settings', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'projectRunner.mcp.port': MCP_PORT, 'projectRunner.mcp.enabled': false }),
  );
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    await waitForTerminal(win);
    const frame = await runnerFrame(win);
    await expect(frame.getByTestId('runner-mcp')).toHaveAttribute('data-state', 'off');
    await expect(fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: 'POST' })).rejects.toThrow();
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'projectRunner.mcp.enabled': true }));
    await expect(frame.getByTestId('runner-mcp')).toHaveAttribute('data-state', 'on');
    expect((await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: 'POST' })).status).toBe(401);
  } finally {
    await app.close();
  }
});
