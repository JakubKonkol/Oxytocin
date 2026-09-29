import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { waitForTerminal } from './helpers/terminal';

// M9-T2: E2E runs use a scripted update backend in main (never the network); see e2e-update-backend.ts.
test('auto-update: check, background download, restart through QuitGuard', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  // A long-running "agent" keeps QuitGuard busy.
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'terminal.profiles': [
        {
          id: 'agent:fake',
          name: 'Fake Agent',
          kind: 'agent',
          command: 'node -e "setInterval(() => {}, 1000)"',
          source: 'user',
        },
      ],
    }),
  );
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  const setGlobal = (name: string, value: unknown) =>
    app.evaluate(
      (_e, [n, v]) => {
        (globalThis as Record<string, unknown>)[n] = v;
      },
      [name, value] as const,
    );
  let exited = false;
  app.process().once('exit', () => (exited = true));
  try {
    await waitForTerminal(win);
    const status = win.getByTestId('status-update');
    // The current version from package.json (hard-coding it broke the test on every release).
    const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    await expect(status).toHaveText(`v${version}`);
    await expect(status).toHaveAttribute('data-kind', 'version');

    // Up to date: the palette command reports it.
    await setGlobal('__oxyFakeUpdate', null);
    await win.keyboard.press('Control+Shift+KeyP');
    await win.keyboard.type('check for updates');
    await win.keyboard.press('Enter');
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'is the latest version' })).toBeVisible();

    // A failing check shows the error.
    await setGlobal('__oxyFakeUpdate', { error: 'net::ERR_INTERNET_DISCONNECTED' });
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Check for Updates…' }).click();
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Could not check for updates' })).toContainText(
      'ERR_INTERNET_DISCONNECTED',
    );

    // A newer version downloads in the background (the beta channel is passed to the updater); the click that found
    // it opens the popover with the progress, which then offers "Install now" or "On restart".
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'updates.channel': 'beta' }));
    await setGlobal('__oxyFakeUpdateStepMs', 400);
    await setGlobal('__oxyFakeUpdate', { version: '9.9.0' });
    await status.click();
    const panel = win.getByTestId('update-panel');
    await expect(panel.getByTestId('update-panel-title')).toHaveText('Downloading Oxytocin 9.9.0');
    await expect(panel.getByRole('progressbar')).toBeVisible();
    await expect(panel).toContainText('MB of 120.0 MB');
    await expect(panel.getByTestId('update-panel-title')).toHaveText('Oxytocin 9.9.0 is ready to install');
    await expect(status).toHaveAttribute('data-kind', 'ready');
    await expect(status).toHaveText('Restart to update');
    // The popover already says it: no toast on top.
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'is ready to install' })).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as Record<string, unknown>)['__oxyUpdateChannel'])).toBe('beta');

    // "On restart" keeps working; the status bar keeps offering the update.
    await panel.getByRole('button', { name: 'On restart' }).click();
    await expect(panel).toBeHidden();
    await expect(status).toHaveText('Restart to update');
    expect(exited).toBe(false);

    // Restart with a running agent: QuitGuard asks; "Cancel" keeps the app and the update.
    await win.evaluate(() => window.oxy.invoke('terminals:create', { projectId: 'default', profileId: 'agent:fake' }));
    await setGlobal('__oxyQuitGuardAnswer', 'cancel');
    await status.click();
    await panel.getByRole('button', { name: 'Install now' }).click();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (globalThis as unknown as { __oxyMain: { lastQuitPrompt(): unknown } }).__oxyMain.lastQuitPrompt(),
        ),
      )
      .not.toBeNull();
    await win.waitForTimeout(300);
    expect(exited).toBe(false);
    await expect(status).toHaveText('Restart to update');

    // "Quit": the update installs with a restart into the new version.
    await setGlobal('__oxyQuitGuardAnswer', 'quit');
    await status.click();
    await panel.getByRole('button', { name: 'Install now' }).click();
    await expect.poll(() => exited, { timeout: 15_000 }).toBe(true);
    expect(JSON.parse(await readFile(join(userData, 'e2e-update-installed.json'), 'utf8'))).toEqual({ restart: true });
  } finally {
    if (!exited) await app.close();
  }
});

test('a failed download shows the error and downloads again on retry', async () => {
  const { app, win } = await launchApp();
  const setGlobal = (name: string, value: unknown) =>
    app.evaluate(
      (_e, [n, v]) => {
        (globalThis as Record<string, unknown>)[n] = v;
      },
      [name, value] as const,
    );
  try {
    await waitForTerminal(win);
    const status = win.getByTestId('status-update');
    await setGlobal('__oxyFakeUpdateStepMs', 50);
    await setGlobal('__oxyFakeUpdate', { version: '9.9.0', downloadError: 'Cannot download, status 404' });
    await win.evaluate(() => window.oxy.invoke('updates:check'));
    await expect(status).toHaveAttribute('data-kind', 'failed');
    await expect(status).toHaveText('Update failed');

    await status.click();
    const panel = win.getByTestId('update-panel');
    await expect(panel.getByTestId('update-panel-title')).toHaveText('Could not download Oxytocin 9.9.0');
    await expect(panel.getByTestId('update-panel-description')).toHaveText('Cannot download, status 404');

    await setGlobal('__oxyFakeUpdate', { version: '9.9.0' });
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByTestId('update-panel-title')).toHaveText('Oxytocin 9.9.0 is ready to install');
    await expect(panel.getByRole('button', { name: 'Install now' })).toBeVisible();
    await expect(status).toHaveAttribute('data-kind', 'ready');
  } finally {
    await app.close();
  }
});

test('a downloaded update installs on a normal quit without restarting', async () => {
  const { app, win, userData } = await launchApp();
  let exited = false;
  app.process().once('exit', () => (exited = true));
  try {
    await waitForTerminal(win);
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyFakeUpdate'] = { version: '9.9.0' };
    });
    await win.evaluate(() => window.oxy.invoke('updates:check'));
    await expect(win.getByTestId('status-update')).toHaveAttribute('data-kind', 'ready');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => exited, { timeout: 15_000 }).toBe(true);
    expect(JSON.parse(await readFile(join(userData, 'e2e-update-installed.json'), 'utf8'))).toEqual({
      restart: false,
    });
  } finally {
    if (!exited) await app.close();
  }
});
