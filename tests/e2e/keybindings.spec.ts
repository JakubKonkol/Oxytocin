import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openEditor(win: Page) {
  await win.keyboard.press(`${mod}+Shift+P`);
  await win.keyboard.type('open keyboard shortcuts');
  await expect(win.locator('[data-testid="command-palette-item"][data-selected="true"]')).toHaveAttribute(
    'data-item-id',
    'command:workbench.openKeybindings',
  );
  await win.keyboard.press('Enter');
  await expect(win.getByTestId('keybindings-panel')).toBeVisible();
}

test('keybindings.json overrides defaults, reloads on edits and reports problems', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const file = join(userData, 'keybindings.json');
  await writeFile(
    file,
    `// mine
[
  { "command": "-workbench.toggleSidebar" },
  { "key": "Ctrl+Alt+J", "command": "workbench.toggleSidebar" }
]`,
  );
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    await waitForTerminal(win);
    await expect(win.getByTestId('sidebar')).toBeVisible();
    await win.keyboard.press(`${mod}+Shift+KeyB`);
    await win.waitForTimeout(300);
    await expect(win.getByTestId('sidebar')).toBeVisible();
    // Ctrl+Alt is terminal-safe: works with the terminal focused.
    await win.keyboard.press('Control+Alt+KeyJ');
    await expect(win.getByTestId('sidebar')).toHaveCount(0);
    await win.keyboard.press('Control+Alt+KeyJ');
    await expect(win.getByTestId('sidebar')).toBeVisible();

    // External edit with a syntax error: the last valid shortcuts stay, the editor shows the problem.
    await openEditor(win);
    await writeFile(file, '[ { "key": "Ctrl+Alt+J", ');
    await expect(win.getByTestId('keybindings-problems')).toContainText('Syntax error');
    await win.getByTestId('keybindings-search').focus();
    await win.keyboard.press('Control+Alt+KeyJ');
    await expect(win.getByTestId('sidebar')).toHaveCount(0);
    await win.keyboard.press('Control+Alt+KeyJ');
    // Fixed file: the problem disappears and the defaults are back.
    await writeFile(file, '[]');
    await expect(win.getByTestId('keybindings-problems')).toHaveCount(0);
    await win.keyboard.press(`${mod}+Shift+KeyB`);
    await expect(win.getByTestId('sidebar')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the shortcut editor records, warns about conflicts, removes and resets shortcuts', async () => {
  const { app, win, userData } = await launchApp();
  const file = join(userData, 'keybindings.json');
  try {
    const t = oxyTest(win);
    await waitForTerminal(win);
    await openEditor(win);
    await win.getByTestId('keybindings-search').fill('split right');
    const row = win.locator('[data-testid="keybinding-row"][data-command="terminal.splitRight"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('keybinding-source')).toHaveText('Default');

    // Record: a chord in use shows a conflict; a plain Ctrl+letter chord warns about terminals.
    await row.getByTestId('keybinding-edit').click();
    const recorder = win.getByTestId('keybinding-recorder');
    await expect(recorder).toBeVisible();
    await win.keyboard.press('Control+Shift+KeyT');
    await expect(win.getByTestId('keybinding-recorder-conflict')).toContainText('Terminal: New Terminal');
    await win.keyboard.press('Control+KeyB');
    await expect(win.getByTestId('keybinding-recorder-terminal')).toBeVisible();
    await win.keyboard.press('Control+Alt+KeyR');
    await expect(win.getByTestId('keybinding-recorder-conflict')).toHaveCount(0);
    await expect(win.getByTestId('keybinding-recorder-terminal')).toHaveCount(0);
    // The recorder captures app shortcuts instead of running them.
    await expect(win.getByTestId('command-palette')).toHaveCount(0);
    await win.keyboard.press('Enter');
    await expect(recorder).toHaveCount(0);

    await expect(row.getByTestId('keybinding-source')).toHaveText('User');
    await expect(row.getByTestId('keybinding-chords')).toContainText('Ctrl+Alt+R');
    await expect(row.getByTestId('keybinding-chords')).not.toContainText('Alt+Shift+=');
    await expect
      .poll(async () => JSON.parse((await readFile(file, 'utf8')).replace(/^\s*\/\/.*$/gm, '')) as unknown)
      .toEqual([{ command: '-terminal.splitRight' }, { key: 'Ctrl+Alt+R', command: 'terminal.splitRight' }]);

    // The new chord splits the terminal; the old one no longer does.
    const termPanel = (await t.workspace())!.panels.find((p) => p.terminalId)!;
    await win.getByTestId(`tab-${termPanel.id}`).click();
    await win.getByTestId(`terminal-view-${termPanel.terminalId}`).click();
    await win.keyboard.press('Alt+Shift+Equal');
    await win.waitForTimeout(300);
    expect((await t.workspace())?.panels.filter((p) => p.terminalId).length).toBe(1);
    await win.keyboard.press('Control+Alt+KeyR');
    await expect.poll(async () => (await t.workspace())?.panels.filter((p) => p.terminalId).length).toBe(2);

    // Remove, then reset to the default.
    await win.getByTestId('tab-keybindings-editor').click();
    await row.hover();
    await row.getByTestId('keybinding-remove').click();
    await expect(row.getByTestId('keybinding-chords')).toContainText('—');
    await row.getByTestId('keybinding-reset').click();
    await expect(row.getByTestId('keybinding-source')).toHaveText('Default');
    await expect(row.getByTestId('keybinding-chords')).toContainText('Alt+Shift+=');
    await expect.poll(async () => (await readFile(file, 'utf8')).includes('splitRight')).toBe(false);

    // "Open keybindings.json" opens the file in the configured editor.
    await win.getByTestId('keybindings-open-file').click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __oxyMain: { editor: { recorded: { path: string }[] } } }).__oxyMain.editor
              .recorded,
        ),
      )
      .toEqual([expect.objectContaining({ path: file })]);
  } finally {
    await app.close();
  }
});
