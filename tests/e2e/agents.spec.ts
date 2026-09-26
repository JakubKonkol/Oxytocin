import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
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
    // The terminal is on screen: no toast.
    await expect(win.locator('[data-sonner-toast]')).toHaveCount(0);

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

test('a waiting agent in a background project raises attention, a toast and an OS notification', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-projects-'));
  const [alpha, beta] = [join(root, 'alpha'), join(root, 'beta')];
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const { app, win } = await launchApp({ project: alpha, env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    const id = await waitForTerminal(win);
    const alphaId = await activeProjectId(win);
    const alphaDot = win.getByTestId(`status-dot-${alphaId}`);
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyWindowFocused'] = false;
    });
    await run(win, `node "${fakeClaude}"`);
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('AI AGENT', { timeout: 10_000 });
    await run(win, 'work');
    await expect(alphaDot).toHaveAttribute('data-state', 'agent-working', { timeout: 10_000 });
    await expect(win.getByTestId('status-agents-working')).toHaveText('1 agent working');
    await run(win, 'ask 3');

    await app.evaluate((_e, p) => {
      (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] = p;
    }, beta);
    await win.getByRole('button', { name: 'Add project' }).click();
    await expect(win.getByTestId('projects-item-beta')).toHaveAttribute('aria-selected', 'true');

    await expect(alphaDot).toHaveAttribute('data-state', 'attention', { timeout: 10_000 });
    await expect(
      win.locator('[data-sonner-toast]').filter({ hasText: 'Claude Code is waiting for tool permission' }),
    ).toBeVisible();
    await expect(win.getByTestId('status-agents-waiting')).toHaveText('1 waiting');
    await expect.poll(() => win.title()).toMatch(/^\(1\) /);
    const main = () =>
      app.evaluate(() => {
        const m = (globalThis as Record<string, unknown>)['__oxyMain'] as {
          osNotifications: { title: string }[];
          attentionCount: () => number;
        };
        return { titles: m.osNotifications.map((n) => n.title), count: m.attentionCount() };
      });
    await expect.poll(main).toEqual({ titles: ['Claude Code is waiting for tool permission'], count: 1 });

    // Ctrl+Shift+J jumps back to the waiting agent.
    await win.keyboard.press('Control+Shift+KeyJ');
    await expect(win.getByTestId('projects-item-alpha')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(id);
    await run(win, 'done');
    await expect(alphaDot).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    await expect.poll(() => win.title()).not.toMatch(/^\(/);
    await expect.poll(async () => (await main()).count).toBe(0);
  } finally {
    await app.close();
  }
});

test('an error exit marks the project until the terminal is seen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oxy-e2e-projects-'));
  const [alpha, beta] = [join(root, 'alpha'), join(root, 'beta')];
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const { app, win } = await launchApp({ project: alpha });
  try {
    await waitForTerminal(win);
    const alphaId = await activeProjectId(win);
    await app.evaluate((_e, p) => {
      (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] = p;
    }, beta);
    await win.getByRole('button', { name: 'Add project' }).click();
    await expect(win.getByTestId('projects-item-beta')).toHaveAttribute('aria-selected', 'true');
    // Exit the shell itself with an error while the project is in the background.
    await app.evaluate(async (_e, pid) => {
      const m = (globalThis as Record<string, unknown>)['__oxyMain'] as {
        terminals: { list(p: string): { id: string }[] };
        hosts: { pty: { call(m: string, a: unknown): Promise<unknown> } };
      };
      const t = m.terminals.list(pid)[0]!;
      await m.hosts.pty.call('write', { id: t.id, data: 'exit 3\r' });
    }, alphaId);
    const alphaDot = win.getByTestId(`status-dot-${alphaId}`);
    await expect(alphaDot).toHaveAttribute('data-state', 'error', { timeout: 10_000 });
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Process exited with code 3' })).toBeVisible();

    await win.getByTestId('projects-item-alpha').click();
    await expect(alphaDot).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
  } finally {
    await app.close();
  }
});
