import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('find widget searches the buffer', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(win, nodeCmd("for (let i = 0; i < 3; i++) console.log('needle-' + i)"));
    await expect.poll(() => oxyTest(win).text(id)).toContain('needle-2');
    await win.keyboard.press('Control+Shift+KeyF');
    await expect(win.getByTestId('terminal-search')).toBeVisible();
    await win.keyboard.type('needle-');
    await expect(win.getByTestId('terminal-search-count')).toHaveText(/of [34]/);
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('terminal-search')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('OSC title and BEL update the header', async () => {
  const { app, win } = await launchApp();
  try {
    await waitForTerminal(win);
    // Keep the process running: shells reset the title from their prompt.
    await run(
      win,
      nodeCmd(
        "process.stdout.write(String.fromCharCode(27) + ']0;Custom ' + 'Title' + String.fromCharCode(7) + String.fromCharCode(7)); setInterval(() => {}, 1000)",
      ),
    );
    await expect(win.getByTestId('tab-title')).toHaveText('Custom Title');
    await expect(win.getByTestId('terminal-bell')).toBeVisible();
    await win.keyboard.press('Control+C');
  } finally {
    await app.close();
  }
});

test('an exit with a non-zero code shows the exit bar and Restart starts a new shell', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(win, 'exit 3');
    await expect(win.getByTestId('terminal-exit-bar')).toContainText('Process exited with code 3');
    await expect(win.locator('[data-testid^="tab-"]').first()).toContainText('EXITED (3)');
    await win.getByRole('button', { name: 'Restart' }).click();
    await expect(win.getByTestId('terminal-exit-bar')).toHaveCount(0);
    await expect.poll(() => win.locator('[data-terminal-id]').first().getAttribute('data-terminal-id')).not.toBe(id);
    const newId = await waitForTerminal(win);
    expect(newId).not.toBe(id);
    // The previous output stays above a separator.
    await expect.poll(() => oxyTest(win).text(newId)).toContain('── Restarted ──');
  } finally {
    await app.close();
  }
});

test('Ctrl+click on a file path opens it in the editor', async () => {
  const { app, win, userData } = await launchApp();
  try {
    const file = join(userData, 'link-target.txt');
    await writeFile(file, 'hello\n');
    const id = await waitForTerminal(win);
    const target = `${file.replace(/\\/g, '/')}:3`;
    await run(win, nodeCmd(`console.log('LINK' + ' ' + '${target}')`));
    await expect.poll(() => oxyTest(win).text(id)).toContain(`LINK ${target}`);
    const pos = await oxyTest(win).position(id, `LINK ${target.slice(0, 5)}`);
    pos!.x += 60;
    await win.mouse.move(pos!.x, pos!.y);
    await win.waitForTimeout(300);
    await win.keyboard.down('Control');
    await win.mouse.move(pos!.x + 2, pos!.y);
    await win.mouse.click(pos!.x + 2, pos!.y);
    await win.keyboard.up('Control');
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __oxyMain: { editor: { recorded: unknown[] } } }).__oxyMain.editor.recorded,
        ),
      )
      .toEqual([expect.objectContaining({ line: 3 })]);
  } finally {
    await app.close();
  }
});

test('the context menu offers terminal actions', async () => {
  test.skip(process.platform === 'win32', 'Windows defaults to right-click copy/paste');
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await win.getByTestId(`terminal-view-${id}`).click({ button: 'right' });
    const menu = win.getByTestId('terminal-context-menu');
    for (const label of ['Copy', 'Paste', 'Select all', 'Find…', 'Clear', 'Restart', 'Close']) {
      await expect(menu.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await menu.getByRole('menuitem', { name: /^Find/ }).click();
    await expect(win.getByTestId('terminal-search')).toBeVisible();
  } finally {
    await app.close();
  }
});
