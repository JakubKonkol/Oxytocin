import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
const fakeCli = join(repoRoot, 'tests/fixtures/agents/fake-claude-plugin-cli.mjs');
const PORT = 47391;

interface Agent {
  terminalId: string;
  state: string;
  stateSource: string;
  sessionId?: string;
  waitingFor?: string;
}

/** A `claude` command that runs the fake plugin CLI (a .cmd on Windows). */
async function claudeWrapper(dir: string, log: string): Promise<string> {
  if (process.platform === 'win32') {
    const path = join(dir, 'claude.cmd');
    await writeFile(path, `@set "FAKE_CLAUDE_CLI_LOG=${log}"\r\n@"${process.execPath}" "${fakeCli}" %*\r\n`);
    return path;
  }
  const path = join(dir, 'claude');
  await writeFile(path, `#!/bin/sh\nFAKE_CLAUDE_CLI_LOG="${log}" exec "${process.execPath}" "${fakeCli}" "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

const agents = (win: Page) => win.evaluate(() => window.oxy.invoke('agents:list')) as Promise<Agent[]>;

// M9-T5: Claude Code hooks → the bridge endpoint → agent states from the `hook` source; install/remove with consent.
test('Claude Code Bridge: hook events drive agent states; the setup panel installs and removes the hooks', async () => {
  test.setTimeout(90_000);
  const work = await mkdtemp(join(tmpdir(), 'oxy-e2e-bridge-'));
  const cliLog = join(work, 'cli.log');
  await writeFile(cliLog, '');
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const hooksJson = join(
    userData,
    'plugin-data/oxytocin.claude-code-bridge/claude-marketplace/oxytocin-bridge/hooks/hooks.json',
  );
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'claudeBridge.port': PORT,
      'claudeBridge.claudeCommand': await claudeWrapper(work, cliLog),
      'terminal.env': { FAKE_CLAUDE_HOOKS: hooksJson },
    }),
  );
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({
    userData,
    project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')),
    env: { CLAUDE_CONFIG_DIR: claudeDir },
  });
  try {
    const id = await waitForTerminal(win);
    // The generated Claude Code plugin points at the configured port.
    await expect
      .poll(() => readFile(hooksJson, 'utf8').catch(() => ''))
      .toContain(`http://127.0.0.1:${PORT}/claude/hook`);

    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    const badge = win.getByTestId('terminal-kind-badge');
    await expect(badge).toHaveText('AI AGENT', { timeout: 10_000 });
    // Claude Code runs without the bridge: the status bar offers the setup.
    const hint = win.getByTestId('status-item-claudeBridge.hint');
    await expect(hint).toContainText('Claude Code hooks');

    // Hook requests carry the terminal's token and id (interpolated like Claude Code does).
    await run(win, 'hook UserPromptSubmit');
    await expect.poll(() => oxyTest(win).text(id)).toContain('hook UserPromptSubmit 204');
    await expect
      .poll(async () => (await agents(win)).find((a) => a.terminalId === id))
      .toMatchObject({ state: 'working', stateSource: 'hook', sessionId: expect.stringMatching(/^fake-/) });
    await run(win, 'hook PermissionRequest');
    await expect(badge).toHaveText('WAITING', { timeout: 10_000 });
    await expect(win.getByTestId('tab-status-dot')).toHaveAttribute('title', /waiting for tool permission/);
    await run(win, 'hook Stop');
    await expect(badge).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    expect((await agents(win)).find((a) => a.terminalId === id)?.stateSource).toBe('hook');
    // Without the token (Claude Code outside Oxytocin): rejected.
    const outside = await fetch(`http://127.0.0.1:${PORT}/claude/hook`, {
      method: 'POST',
      headers: { authorization: 'Bearer ', 'x-oxytocin-terminal': id },
      body: '{"hook_event_name":"UserPromptSubmit"}',
    });
    expect(outside.status).toBe(401);

    // Setup panel (from the hint, which then goes away): explains, installs with the claude CLI, removes.
    await hint.click();
    await expect(hint).toHaveCount(0);
    const frame = () => win.frames().find((f) => f.url().startsWith('oxy-plugin://oxytocin.claude-code-bridge/'));
    await expect.poll(() => !!frame(), { timeout: 15_000 }).toBe(true);
    const panel = frame()!;
    await expect(panel.locator('#status-endpoint')).toHaveText(`listening on 127.0.0.1:${PORT}`);
    await expect(panel.locator('#status-installed')).toHaveText('not installed');
    await expect(panel.locator('#status-events')).toContainText('3 received');
    await panel.locator('#install').click();
    await expect(panel.locator('#output')).toContainText('Successfully installed plugin: oxytocin-bridge@oxytocin');
    await expect(panel.locator('#status-installed')).toHaveText('the bridge is installed');
    const calls = async () =>
      (await readFile(cliLog, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as string[]).join(' '));
    const marketplace = join(userData, 'plugin-data/oxytocin.claude-code-bridge/claude-marketplace');
    expect(await calls()).toEqual(
      expect.arrayContaining([
        `plugin marketplace add ${marketplace}`,
        'plugin install oxytocin-bridge@oxytocin --scope user',
      ]),
    );
    await panel.locator('#uninstall').click();
    await expect(panel.locator('#status-installed')).toHaveText('not installed');
    expect(await calls()).toContain('plugin marketplace remove oxytocin');
  } finally {
    await app.close();
  }
});
