import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';
import { fixturePlugin, userDataWithPlugins } from './helpers/plugins';

const row = (win: Page, id: string) => win.locator(`[data-testid="plugin-row"][data-plugin-id="${id}"]`);

test('plugin manager: disabling removes views, status bar items and environment; enable, reload and logs', async () => {
  const userData = await userDataWithPlugins(['echo', 'views']);
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    await waitForTerminal(win);
    await expect(win.getByTestId('status-item-echo.status')).toBeVisible({ timeout: 10_000 });
    const sidebarView = win.getByTestId('section-header-plugin:test.views:views.sidebar');
    await expect(sidebarView).toBeVisible();

    await win.getByTestId('status-plugins').click();
    const panel = win.getByTestId('plugins-panel');
    await expect(panel).toBeVisible();
    await expect(row(win, 'oxytocin.markdown-preview')).toContainText('built-in');
    await expect(row(win, 'test.echo').getByTestId('plugin-state')).toHaveText('active');

    // Logs of the backend.
    await row(win, 'test.echo').getByRole('button', { name: 'Show logs' }).click();
    await expect(row(win, 'test.echo').getByTestId('plugin-logs')).toContainText('echo activated');

    // Disable: status bar item and environment go away (running terminal → ⟳), sidebar view disappears.
    await row(win, 'test.echo').getByRole('button', { name: 'Disable' }).click();
    await expect(row(win, 'test.echo').getByTestId('plugin-state')).toHaveText('disabled');
    await expect(win.getByTestId('status-item-echo.status')).toHaveCount(0);
    await expect(win.getByTestId('tab-env-stale')).toBeVisible();
    await row(win, 'test.views').getByRole('button', { name: 'Disable' }).click();
    await expect(sidebarView).toHaveCount(0);

    // Enable again.
    await row(win, 'test.echo').getByRole('button', { name: 'Enable' }).click();
    await expect(win.getByTestId('status-item-echo.status')).toBeVisible({ timeout: 10_000 });
    await row(win, 'test.views').getByRole('button', { name: 'Enable' }).click();
    await expect(sidebarView).toBeVisible();

    // Reload deactivates and activates the backend again.
    await row(win, 'test.echo').getByRole('button', { name: 'Reload' }).click();
    await expect
      .poll(async () => (await row(win, 'test.echo').getByTestId('plugin-logs').textContent()) ?? '')
      .toMatch(/echo activated[\s\S]*echo activated/);
  } finally {
    await app.close();
  }
});

test('plugin manager: load a plugin from a folder in developer mode and reload it on changes', async () => {
  const userData = await userDataWithPlugins([]);
  const dev = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-devplugin-')), 'echo');
  await cp(fixturePlugin('echo'), dev, { recursive: true });
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    await waitForTerminal(win);
    await win.getByTestId('status-plugins').click();
    await expect(win.getByTestId('plugins-developer-mode')).toBeChecked();
    await app.evaluate((_e, p) => {
      (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] = p;
    }, dev);
    await win.getByRole('button', { name: 'Load plugin from folder…' }).click();
    await expect(row(win, 'test.echo')).toContainText('dev');
    await expect(win.getByTestId('status-item-echo.status')).toHaveText('echo', { timeout: 10_000 });

    // Editing the plugin's files reloads it.
    const host = join(dev, 'host.js');
    await writeFile(host, (await readFile(host, 'utf8')).replace("'$(pulse) echo'", "'$(pulse) echo v2'"));
    await expect(win.getByTestId('status-item-echo.status')).toHaveText('echo v2', { timeout: 10_000 });

    // Removing the folder unloads it.
    await row(win, 'test.echo').getByRole('button', { name: 'Remove' }).click();
    await expect(row(win, 'test.echo')).toHaveCount(0);
    await expect(win.getByTestId('status-item-echo.status')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
