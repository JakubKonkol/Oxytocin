import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('a crashed window reloads by itself and reconnects to its running terminal', async () => {
  const { app, win } = await launchApp();
  try {
    const id = await waitForTerminal(win);
    await run(win, nodeCmd("console.log('before-' + 'crash')"));
    await expect.poll(() => oxyTest(win).text(id)).toContain('before-crash');
    const loads = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      const g = globalThis as unknown as { __loads: number };
      g.__loads = 0;
      wc.on('did-finish-load', () => g.__loads++);
      return g.__loads;
    });
    expect(loads).toBe(0);

    // The crash notification as Electron sends it (a real crash also kills Playwright's connection to the page).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.emit(
        'render-process-gone',
        { preventDefault: () => undefined },
        { reason: 'crashed', exitCode: 139 },
      );
    });

    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __loads: number }).__loads)).toBe(1);
    await expect(win.getByTestId('app-ready')).toBeVisible({ timeout: 20_000 });
    expect(await waitForTerminal(win)).toBe(id);
    await expect.poll(() => oxyTest(win).text(id)).toContain('before-crash');
    await win.getByTestId(`terminal-view-${id}`).click();
    await run(win, nodeCmd("console.log('after-' + 'crash')"));
    await expect.poll(() => oxyTest(win).text(id)).toContain('after-crash');
  } finally {
    await app.close();
  }
});

test('the application menu has no close shortcut and its commands reach the window', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible();
    const menu = await app.evaluate(({ Menu }) => {
      const roles: string[] = [];
      const walk = (items: Electron.MenuItem[]) => {
        for (const item of items) {
          if (item.role) roles.push(item.role.toLowerCase());
          if (item.submenu) walk(item.submenu.items);
        }
      };
      walk(Menu.getApplicationMenu()?.items ?? []);
      return { roles };
    });
    expect(menu.roles).toContain('togglefullscreen');
    expect(menu.roles).not.toContain('close');

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('app:menuCommand', { command: 'workbench.openSettings' }),
    );
    await expect(win.getByTestId('settings-panel')).toBeVisible();
  } finally {
    await app.close();
  }
});
