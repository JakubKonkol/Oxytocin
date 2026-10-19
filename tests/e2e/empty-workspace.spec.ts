import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { AgentSnapshot } from '@oxytocin/plugin-api';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

test('an empty workspace opens a terminal, an AI agent or anything from the + menu', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-empty-'));
  const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ 'usage.pricing.autoUpdate': false, 'aiAgents.commands': { claude: `node "${fakeClaude}"` } }),
  );
  await writeFile(
    join(userData, 'ai-agents.json'),
    JSON.stringify({
      version: 1,
      detectedAt: Date.now(),
      agents: [{ id: 'claude', name: 'Claude Code', command: 'claude', category: 'agent', accounts: [] }],
    }),
  );
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    // Close the only terminal: the workspace shows its choices.
    await win.getByTestId(`terminal-view-${first}`).click();
    await win.keyboard.press('Control+Shift+P');
    await win.keyboard.type('close panel');
    await expect(win.locator('[data-testid="command-palette-item"][data-selected="true"]')).toHaveAttribute(
      'data-item-id',
      'command:panel.close',
    );
    await win.keyboard.press('Enter');
    const empty = win.getByTestId('empty-workspace');
    await expect(empty).toBeVisible();
    await expect(empty.getByTestId('empty-new-terminal')).toBeVisible();
    await expect(empty.getByTestId('empty-open-menu')).toBeVisible();
    await win.screenshot({ path: test.info().outputPath('empty-workspace.png') });

    // An AI agent straight away, without a shell terminal first.
    await empty.getByTestId('empty-ai-ai:claude').click();
    let agentTerminal = '';
    await expect
      .poll(
        async () =>
          (agentTerminal =
            ((await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[]).find(
              (a) => a.agentId === 'claude-code',
            )?.terminalId ?? ''),
        { timeout: 20_000 },
      )
      .not.toBe('');
    expect((await t.workspace())?.panels.map((p) => p.terminalId)).toEqual([agentTerminal]);

    // "Open…" has the same choices as a group's +: terminal profiles, AI agents and tools.
    await win.getByTestId(`terminal-view-${agentTerminal}`).click();
    await win.keyboard.press('Control+Shift+P');
    await win.keyboard.type('close panel');
    await win.keyboard.press('Enter');
    // A running agent is terminated only after a confirmation.
    await win.getByRole('alertdialog').getByRole('button', { name: 'Terminate' }).click();
    await expect(empty).toBeVisible();
    await empty.getByTestId('empty-open-menu').click();
    const menu = win.getByTestId('group-add-menu');
    await expect(menu.getByTestId('add-terminal')).toBeVisible();
    await expect(menu.getByTestId('add-ai-ai:claude')).toBeVisible();
    await expect(menu.getByTestId('add-tool-scratchpad')).toBeVisible();
    await menu.getByTestId('add-tool-scratchpad').click();
    await expect(empty).toHaveCount(0);
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(1);
  } finally {
    await app.close();
  }
});
