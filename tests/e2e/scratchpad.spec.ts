import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');

test('the title bar opens settings and toggles the right sidebar', async () => {
  const { app, win } = await launchApp({ secondarySidebar: true });
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
  const { app, win } = await launchApp({ env: { CLAUDE_CONFIG_DIR: claudeDir }, secondarySidebar: true });
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

test('the scratchpad can be kept per project and shared again after a confirmation', async () => {
  const beta = await mkdtemp(join(tmpdir(), 'oxy-e2e-beta-'));
  const first = await launchApp({ secondarySidebar: true });
  const { userData } = first;
  const ids = async (win: typeof first.win) => {
    // By folder name: on Windows the temp path may be spelled differently (8.3 short names) than the project root.
    const list = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as { id: string; rootPath: string }[];
    const isBeta = (p: { rootPath: string }) => basename(p.rootPath) === basename(beta);
    return { alpha: list.find((p) => !isBeta(p))!.id, beta: list.find(isBeta)!.id };
  };
  const activate = (win: typeof first.win, id: string) =>
    win.evaluate((projectId) => window.oxy.invoke('projects:setActive', { id: projectId }), id);
  try {
    const { win } = first;
    await waitForTerminal(win);
    await win.evaluate((path) => window.oxy.invoke('projects:add', { path }), beta);
    const p = await ids(win);
    await activate(win, p.alpha);
    const input = win.getByTestId('scratchpad-input');
    const shared = win.getByTestId('scratchpad-shared');
    await expect(shared).toBeChecked();
    await input.fill('shared notes');

    // Off: the current project keeps its text, the other one starts empty and keeps its own.
    await shared.uncheck();
    await expect(input).toHaveValue('shared notes');
    await activate(win, p.beta);
    await expect(input).toHaveValue('');
    await input.fill('beta notes');
    await activate(win, p.alpha);
    await expect(input).toHaveValue('shared notes');
    await input.fill('alpha notes');
    await expect
      .poll(
        async () =>
          ((await win.evaluate(() => window.oxy.invoke('ui:getState'))) as { scratchpad: unknown }).scratchpad,
      )
      .toMatchObject({ shared: false, projects: { [p.alpha]: 'alpha notes', [p.beta]: 'beta notes' } });
    // Quitting right after typing keeps the text (the debounced save is flushed).
    await input.fill('alpha notes!');
  } finally {
    await first.app.close();
  }

  // Kept across restarts.
  const { app, win } = await launchApp({ userData });
  try {
    await waitForTerminal(win);
    const p = await ids(win);
    const input = win.getByTestId('scratchpad-input');
    const shared = win.getByTestId('scratchpad-shared');
    await activate(win, p.beta);
    await expect(input).toHaveValue('beta notes');
    await expect(shared).not.toBeChecked();
    await activate(win, p.alpha);
    await expect(input).toHaveValue('alpha notes!');

    // Sharing again replaces the other project's scratchpad: asked first.
    await shared.click();
    const dialog = win.getByRole('alertdialog');
    await expect(dialog).toContainText('Share one scratchpad across projects?');
    await expect(dialog).toContainText('The scratchpad of');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(shared).not.toBeChecked();
    await activate(win, p.beta);
    await expect(input).toHaveValue('beta notes');
    await activate(win, p.alpha);

    await shared.click();
    await win.getByRole('alertdialog').getByRole('button', { name: 'Share and replace' }).click();
    await expect(shared).toBeChecked();
    await activate(win, p.beta);
    await expect(input).toHaveValue('alpha notes!');
  } finally {
    await app.close();
  }
});
