import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');

test('the title bar opens settings and toggles the right sidebar', async () => {
  const { app, win } = await launchApp();
  try {
    await waitForTerminal(win);
    await win.getByTestId('open-settings').click();
    await expect(win.getByTestId('settings-panel')).toBeVisible();

    const sidebar = win.getByTestId('secondary-sidebar');
    const toggle = win.getByTestId('toggle-secondary-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(sidebar).toHaveCount(0);
    await toggle.click();
    await expect(sidebar).toBeVisible();
    // Same default width as the left sidebar.
    const left = await win.getByTestId('sidebar').boundingBox();
    const right = await sidebar.boundingBox();
    expect(Math.round(right!.width)).toBe(Math.round(left!.width));
  } finally {
    await app.close();
  }
});

test('the scratchpad persists notes and sends them to the running agent', async () => {
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({ env: { CLAUDE_CONFIG_DIR: claudeDir } });
  try {
    const id = await waitForTerminal(win);
    const input = win.getByTestId('scratchpad-input');
    const send = win.getByTestId('scratchpad-send');
    await input.fill('scratchpad prompt 42');
    await expect(send).toHaveAttribute('aria-disabled', 'true');

    await win.locator(`[data-terminal-id="${id}"] .xterm`).click();
    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('AI AGENT', { timeout: 10_000 });

    // The only agent is the target.
    await expect(send).toHaveAttribute('aria-disabled', 'false');
    await send.click();
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude> scratchpad prompt 42');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(id);
    // Pasted, not submitted: the agent has not printed a new prompt yet.
    expect((await oxyTest(win).text(id)).trimEnd().endsWith('scratchpad prompt 42')).toBe(true);

    // The note is kept in ui-state.json.
    await expect
      .poll(async () => {
        const state = (await win.evaluate(() => window.oxy.invoke('ui:getState'))) as { scratchpad: { text: string } };
        return state.scratchpad.text;
      })
      .toBe('scratchpad prompt 42');
  } finally {
    await app.close();
  }
});
