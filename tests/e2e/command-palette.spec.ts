import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { makeRepo } from './helpers/git';
import { launchApp } from './helpers/launch';
import { activeProjectId, oxyTest, waitForTerminal } from './helpers/terminal';

const palette = (win: Page) => win.getByTestId('command-palette');
const input = (win: Page) => win.getByTestId('command-palette-input');
const items = (win: Page) => win.getByTestId('command-palette-item');
const selected = (win: Page) => win.locator('[data-testid="command-palette-item"][data-selected="true"]');

test('command palette runs commands, remembers them and Quick Open jumps to projects, terminals and files', async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src/app.ts'), 'export const app = 1;\n');
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
  const { app, win } = await launchApp({ project: repo });
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    const alpha = await activeProjectId(win);

    // Ctrl+Shift+P from a focused terminal: commands mode, fuzzy search, Enter runs the first match.
    await win.getByTestId(`terminal-view-${first}`).click();
    await win.keyboard.press('Control+Shift+P');
    await expect(palette(win)).toHaveAttribute('data-mode', 'commands');
    await expect(input(win)).toHaveValue('>');
    await expect(input(win)).toBeFocused();
    await win.keyboard.type('split right');
    await expect(selected(win)).toHaveAttribute('data-item-id', 'command:terminal.splitRight');
    await expect(selected(win).locator('mark').first()).toBeVisible();
    await win.keyboard.press('Enter');
    await expect(palette(win)).toBeHidden();
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);

    // Recently used commands come first; Escape closes without running anything.
    await win.keyboard.press('Control+Shift+P');
    await expect(items(win).first()).toHaveAttribute('data-item-id', 'command:terminal.splitRight');
    await expect(palette(win).getByText('Recently used')).toBeVisible();
    // Keybindings are shown next to commands.
    await win.keyboard.type('new terminal');
    await expect(selected(win)).toHaveAttribute('data-item-id', 'command:terminal.new');
    await expect(selected(win).locator('kbd')).toHaveText(process.platform === 'darwin' ? '⌘T' : 'Ctrl+Shift+T');
    await win.keyboard.press('Escape');
    await expect(palette(win)).toBeHidden();
    expect((await t.workspace())?.panels.length).toBe(2);

    // Quick Open (no prefix): projects.
    const betaDir = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-palette-')), 'beta-project');
    await mkdir(betaDir);
    await win.evaluate((p) => window.oxy.invoke('projects:add', { path: p }), betaDir);
    await expect.poll(() => activeProjectId(win)).not.toBe(alpha);
    const beta = await activeProjectId(win);
    await win.evaluate((id) => window.oxy.invoke('projects:setActive', { id }), alpha);
    await expect.poll(() => activeProjectId(win)).toBe(alpha);
    await win.keyboard.press('Control+Shift+O');
    await expect(palette(win)).toHaveAttribute('data-mode', 'all');
    await win.keyboard.type('beta proj');
    await expect(selected(win)).toHaveAttribute('data-item-id', `project:${beta}`);
    await win.keyboard.press('Enter');
    await expect.poll(() => activeProjectId(win)).toBe(beta);

    // `@`: terminals of every project; picking one of alpha's activates alpha and focuses the panel.
    await win.keyboard.press('Control+Shift+O');
    await win.keyboard.type('@');
    await expect(palette(win)).toHaveAttribute('data-mode', 'terminals');
    await expect(palette(win).locator(`[data-item-id="terminal:${first}"]`)).toBeVisible();
    await palette(win).locator(`[data-item-id="terminal:${first}"]`).click();
    await expect.poll(() => activeProjectId(win)).toBe(alpha);
    await expect
      .poll(async () => (await t.workspace())?.activePanelId)
      .toBe((await t.workspace())?.panels.find((p) => p.terminalId === first)?.id);

    // `#`: changed files of the active project open their diff.
    await win.keyboard.press('Control+Shift+O');
    await win.keyboard.type('#app');
    await expect(selected(win)).toHaveAttribute('data-item-id', 'file:src/app.ts');
    await win.keyboard.press('Enter');
    await expect(win.locator('[data-testid^="tab-diff-"]').filter({ hasText: 'app.ts' })).toBeVisible();

    // No match: an empty state.
    await win.keyboard.press('Control+Shift+O');
    await win.keyboard.type('zzzzqqq');
    await expect(palette(win).getByText('No matching projects, terminals or changed files')).toBeVisible();
    await win.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

test('plugins show quick picks in the palette (Markdown: Open Preview)', async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, 'docs'));
  await writeFile(join(repo, 'README.md'), '# Readme\n');
  await writeFile(join(repo, 'docs/plan.md'), '# The plan\n');
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    await win.keyboard.press('Control+Shift+P');
    await win.keyboard.type('markdown open preview');
    await expect(selected(win)).toHaveAttribute('data-item-id', 'command:markdown.openPreview');
    await win.keyboard.press('Enter');

    await expect(palette(win)).toHaveAttribute('data-mode', 'pick');
    await expect(palette(win).getByTestId('command-palette-source')).toHaveText('Markdown Preview');
    await expect(input(win)).toHaveAttribute('placeholder', 'Open a Markdown preview');
    await expect(items(win)).toHaveCount(2);
    await expect(items(win).first()).toContainText('README.md');
    await win.keyboard.type('plan');
    await expect(items(win)).toHaveCount(1);
    await expect(items(win).first()).toContainText('docs');
    await win.keyboard.press('Enter');

    const frame = async () => {
      for (const f of win.frames()) {
        if (!f.url().startsWith('oxy-plugin://oxytocin.markdown-preview/')) continue;
        const html = await f.evaluate(() => document.getElementById('content')?.innerHTML ?? '').catch(() => '');
        if (html.includes('The plan')) return true;
      }
      return false;
    };
    await expect.poll(frame, { timeout: 15_000 }).toBe(true);

    // Dismissing a pick resolves it as cancelled: nothing opens and the command can run again.
    await win.keyboard.press('Control+Shift+P');
    await win.keyboard.type('markdown open preview');
    await win.keyboard.press('Enter');
    await expect(palette(win)).toHaveAttribute('data-mode', 'pick');
    await win.keyboard.press('Escape');
    await expect(palette(win)).toBeHidden();
    await win.keyboard.press('Control+Shift+P');
    await win.keyboard.type('markdown open preview');
    await win.keyboard.press('Enter');
    await expect(palette(win)).toHaveAttribute('data-mode', 'pick');
    await win.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});
