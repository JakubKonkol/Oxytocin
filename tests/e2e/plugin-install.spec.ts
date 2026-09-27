import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { makeZip } from '../helpers/zip';
import { launchApp } from './helpers/launch';
import { fixturePlugin } from './helpers/plugins';
import { waitForTerminal } from './helpers/terminal';

const invoke = (win: Page, channel: string, payload?: unknown) =>
  win.evaluate(([c, p]) => window.oxy.invoke(c as never, p as never), [channel, payload] as const);

interface Descriptor {
  id: string;
  source: string;
  state: string;
}

// M9-T3: user plugins from a folder or a .zip, consent before the first run, a separate Plugin Host, uninstall.
test('install a plugin from a .zip and a folder, consent, run it in the external host, uninstall', async () => {
  test.setTimeout(90_000);
  const work = await mkdtemp(join(tmpdir(), 'oxy-e2e-install-'));
  const echo = fixturePlugin('echo');
  const zip = join(work, 'echo.zip');
  await writeFile(
    zip,
    makeZip([
      { name: 'echo/' },
      { name: 'echo/package.json', data: await readFile(join(echo, 'package.json')) },
      { name: 'echo/host.js', data: await readFile(join(echo, 'host.js')) },
    ]),
  );
  const { app, win, userData } = await launchApp({ project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  const pick = (answer: string | null) =>
    app.evaluate((_e, a) => {
      (globalThis as Record<string, unknown>)['__oxyPickPluginAnswer'] = a;
    }, answer);
  const echoState = async () => ((await invoke(win, 'plugins:list')) as Descriptor[]).find((p) => p.id === 'test.echo');
  const hosts = async () => (await invoke(win, 'app:getHostStatus')) as { name: string; state: string }[];
  try {
    await waitForTerminal(win);
    // Only built-in plugins: the external Plugin Host is not started.
    expect((await hosts()).find((h) => h.name.endsWith('(external)'))?.state).toBe('stopped');

    await win.getByTestId('status-plugins').click();
    await expect(win.getByTestId('plugins-panel')).toBeVisible();

    // .zip → consent dialog; "Not now" keeps it installed but disabled.
    await pick(zip);
    await win.getByTestId('plugins-install-zip').click();
    const consent = win.getByTestId('plugin-consent');
    await expect(consent).toBeVisible();
    await expect(win.getByRole('alertdialog')).toContainText('Enable Echo (test)?');
    await expect(win.getByTestId('plugin-consent-permissions')).toContainText('Open new terminals and run commands');
    await expect(win.getByTestId('plugin-consent-warning')).toContainText('full access to your computer');
    await win.getByRole('button', { name: 'Not now' }).click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Installed Echo (test)' })).toContainText(
      'stays disabled',
    );
    const row = win.locator('[data-testid="plugin-row"][data-plugin-id="test.echo"]');
    await expect(row).toHaveAttribute('data-state', 'disabled');
    expect(await readdir(join(userData, 'plugins'))).toEqual(['test.echo']);

    // Enable → consent → runs in the external Plugin Host.
    await row.getByRole('button', { name: 'Enable' }).click();
    await expect(consent).toBeVisible();
    await win.getByRole('button', { name: 'Enable', exact: true }).last().click();
    await expect.poll(async () => (await echoState())?.state, { timeout: 20_000 }).toBe('active');
    expect(await echoState()).toMatchObject({ source: 'user' });
    await expect
      .poll(async () => (await hosts()).find((h) => h.name === 'Oxytocin Plugin Host (external)')?.state)
      .toBe('running');
    expect(await invoke(win, 'plugins:executeCommand', { id: 'echo.hello', args: ['x'] })).toMatchObject({
      echo: ['x'],
    });

    // The same plugin from a folder with the same permissions: updated without asking again.
    await pick(echo);
    await win.getByTestId('plugins-install-folder').click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Updated Echo (test) 1.0.0' })).toBeVisible();
    await expect(consent).toHaveCount(0);
    await expect.poll(async () => (await echoState())?.state, { timeout: 20_000 }).toBe('active');

    // Not a plugin: nothing is installed.
    const notPlugin = join(work, 'readme.zip');
    await writeFile(notPlugin, makeZip([{ name: 'README.md', data: '# hi' }]));
    await pick(notPlugin);
    await win.getByTestId('plugins-install-zip').click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Could not install the plugin' })).toContainText(
      'No Oxytocin plugin found',
    );

    // Uninstall: confirmation, files removed.
    await row.getByTestId('plugin-uninstall').click();
    await win.getByRole('button', { name: 'Uninstall' }).click();
    await expect(row).toHaveCount(0);
    await expect(access(join(userData, 'plugins', 'test.echo'))).rejects.toThrow();
    expect(await echoState()).toBeUndefined();
  } finally {
    await app.close();
  }
});
