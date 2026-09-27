import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { makeRepo } from './helpers/git';
import { launchApp } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';

const setTheme = (win: Page, theme: 'dark' | 'light' | 'system') =>
  win.evaluate((t) => window.oxy.invoke('settings:update', { 'appearance.theme': t }), theme);
const htmlTheme = (win: Page) => win.evaluate(() => document.documentElement.dataset['theme']);
const token = (win: Page, name: string) =>
  win.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const xtermTheme = (win: Page, id: string) =>
  win.evaluate(
    (i) =>
      (
        window as unknown as { __oxyTest: { getTerminalTheme(id: string): { background: string; red: string } | null } }
      ).__oxyTest.getTerminalTheme(i),
    id,
  );

function usageFrame(win: Page): Frame | undefined {
  return win.frames().find((f) => f.url().startsWith('oxy-plugin://oxytocin.usage-monitor/'));
}

test('light, dark and system themes restyle the shell, terminals, diffs and plugin views, and persist', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
  const first = await launchApp({ project: repo });
  const { app, win } = first;
  try {
    const terminal = await waitForTerminal(win);
    expect(await htmlTheme(win)).toBe('dark');
    expect(await xtermTheme(win, terminal)).toEqual({
      background: await token(win, '--bg-terminal'),
      red: await token(win, '--ansi-red'),
    });
    await win.locator('[data-testid="changes-row"][data-path="tracked.txt"]').dblclick();
    await expect(win.locator('.monaco-diff-editor')).toBeVisible();
    await expect(win.locator('.monaco-editor.vs-dark').first()).toBeVisible();
    await expect.poll(() => usageFrame(win)?.evaluate(() => document.documentElement.dataset['oxyTheme'])).toBe('dark');

    await setTheme(win, 'light');
    await expect.poll(() => htmlTheme(win)).toBe('light');
    expect(await token(win, '--color-scheme')).toBe('light');
    // xterm re-reads the palette; Monaco switches to the light base theme; the page did not crash.
    await expect
      .poll(() => xtermTheme(win, terminal))
      .toEqual({
        background: await token(win, '--bg-terminal'),
        red: await token(win, '--ansi-red'),
      });
    expect((await xtermTheme(win, terminal))!.background).not.toBe('#0e1116');
    await expect(win.locator('.monaco-editor.vs-dark')).toHaveCount(0);
    await expect(win.locator('.monaco-editor.vs').first()).toBeVisible();
    await expect(win.getByTestId('panel-error')).toHaveCount(0);
    // Plugin views get the new tokens (07 §13).
    await expect
      .poll(() => usageFrame(win)?.evaluate(() => document.documentElement.dataset['oxyTheme']))
      .toBe('light');
    const cardInView = await usageFrame(win)!.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim(),
    );
    expect(cardInView).toBe(await token(win, '--bg-card'));
    // Native theme follows the setting.
    expect(await app.evaluate(({ nativeTheme }) => [nativeTheme.themeSource, nativeTheme.shouldUseDarkColors])).toEqual(
      ['light', false],
    );

    // "system" follows the OS (the test machine's preference).
    await setTheme(win, 'system');
    const osDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    await expect.poll(() => htmlTheme(win)).toBe(osDark ? 'dark' : 'light');

    await setTheme(win, 'light');
    await expect.poll(() => htmlTheme(win)).toBe('light');
    await win.waitForTimeout(400);
  } finally {
    await app.close();
  }

  // The theme applies from the first paint after a restart.
  const second = await launchApp({ userData: first.userData });
  try {
    await expect(second.win.getByTestId('app-ready')).toBeVisible();
    expect(await htmlTheme(second.win)).toBe('light');
    await setTheme(second.win, 'dark');
    await expect.poll(() => htmlTheme(second.win)).toBe('dark');
  } finally {
    await second.app.close();
  }
});
