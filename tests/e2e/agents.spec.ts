import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { activeProjectId, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');

test('a fake Claude Code agent is detected and its registry states drive badge and dots', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({ env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    const id = await waitForTerminal(win);
    const badge = win.getByTestId('terminal-kind-badge');
    const tabDot = win.getByTestId('tab-status-dot');
    const projectDot = win.getByTestId(`status-dot-${await activeProjectId(win)}`);

    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    // Detected from the process tree by command line (the process itself is `node`).
    await expect(badge).toHaveText('AI AGENT', { timeout: 10_000 });
    await expect.poll(() => readdir(join(claudeDir, 'sessions'))).toHaveLength(1);

    await run(win, 'work');
    await expect(badge).toHaveAttribute('data-state', 'working', { timeout: 10_000 });
    await expect(projectDot).toHaveAttribute('data-state', 'agent-working');
    await expect(tabDot).toHaveAttribute('title', /Claude Code is working/);

    await run(win, 'ask');
    await expect(badge).toHaveText('WAITING', { timeout: 10_000 });
    await expect(projectDot).toHaveAttribute('data-state', 'attention');
    await expect(tabDot).toHaveAttribute('title', /Claude Code is waiting for tool permission/);

    await run(win, 'done');
    await expect(badge).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    await expect(projectDot).toHaveAttribute('data-state', 'idle');

    const agents = (await win.evaluate(() => window.oxy.invoke('agents:list'))) as {
      agentId: string;
      sessionId?: string;
    }[];
    expect(agents).toEqual([
      expect.objectContaining({ agentId: 'claude-code', sessionId: expect.stringMatching(/^fake-/) }),
    ]);

    await run(win, 'quit');
    await expect(badge).toHaveText('SHELL', { timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('a running command marks the terminal as PROCESS', async () => {
  const { app, win } = await launchApp();
  try {
    await waitForTerminal(win);
    const badge = win.getByTestId('terminal-kind-badge');
    await expect(badge).toHaveText('SHELL');
    await run(win, nodeCmd('setInterval(() => {}, 1000)'));
    await expect(badge).toHaveText('PROCESS', { timeout: 10_000 });
    await expect(badge).toHaveAttribute('title', /setInterval/);
    await win.keyboard.press('Control+C');
    await expect(badge).toHaveText('SHELL', { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
