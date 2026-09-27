import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

const row = (win: Page, key: string) => win.locator(`[data-testid="setting-row"][data-key="${key}"]`);

async function settingsFile(userData: string): Promise<string> {
  return readFile(join(userData, 'settings.json'), 'utf8');
}

test('settings UI: problems, generated controls, plugin settings, reset and external edits', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const file = join(userData, 'settings.json');
  await writeFile(file, '{\n  // my settings\n  "terminal.fontSize": 99,\n  "git.periodicRefreshSeconds": 20\n}\n');
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')) });
  try {
    // Start-up toast for the invalid value (shown for 10 s: checked before waiting for the terminal, which can take
    // that long on Windows CI) → Settings filtered to problems.
    const toast = win.locator('[data-sonner-toast]').filter({ hasText: 'settings.json has 1 invalid value' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Open Settings' }).click();
    // The terminal tab is behind the Settings tab now: take its id from the test hooks.
    await expect.poll(async () => (await oxyTest(win).terminalIds()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const terminal = (await oxyTest(win).terminalIds())[0]!;
    const termOptions = () =>
      win.evaluate(
        (id) =>
          (
            window as unknown as {
              __oxyTest: { getTerminalOptions(id: string): { fontSize: number; cursorStyle: string } | null };
            }
          ).__oxyTest.getTerminalOptions(id),
        terminal,
      );

    await expect(win.getByTestId('settings-panel')).toBeVisible();
    await expect(win.getByTestId('settings-search')).toHaveValue('@problems');
    await expect(win.getByTestId('setting-row')).toHaveCount(1);
    await expect(row(win, 'terminal.fontSize').getByTestId('setting-problem')).toBeVisible();
    await expect(win.getByTestId('settings-problems')).toContainText('1 invalid value');

    // A number: typing a valid value writes settings.json and keeps its comment; the problem disappears.
    const fontSize = row(win, 'terminal.fontSize').getByTestId('setting-control');
    await expect(fontSize).toHaveValue('13');
    await fontSize.fill('40');
    await fontSize.press('Enter');
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Maximum is 32' })).toBeVisible();
    await fontSize.fill('15');
    await fontSize.press('Enter');
    await expect.poll(() => settingsFile(userData)).toContain('"terminal.fontSize": 15');
    expect(await settingsFile(userData)).toContain('// my settings');
    await expect(win.getByTestId('settings-problems')).toHaveCount(0);
    await win.getByTestId('settings-search').fill('');
    await expect(row(win, 'terminal.fontSize')).toHaveAttribute('data-modified', 'true');
    // Open terminals follow the change.
    await expect.poll(termOptions).toMatchObject({ fontSize: 15 });

    // Sections, a boolean, an enum, and reset.
    await win.locator('[data-testid="settings-section"][data-section="Terminal"]').click();
    await expect(win.locator('[data-testid="settings-group"]')).toHaveCount(1);
    const copy = row(win, 'terminal.copyOnSelect');
    await copy.getByTestId('setting-control').click();
    await expect.poll(() => settingsFile(userData)).toContain('"terminal.copyOnSelect": true');
    await row(win, 'terminal.cursorStyle').getByTestId('setting-control').selectOption({ label: 'Block' });
    await expect.poll(() => settingsFile(userData)).toContain('"terminal.cursorStyle": "block"');
    await expect.poll(termOptions).toMatchObject({ cursorStyle: 'block' });
    await copy.hover();
    await copy.getByTestId('setting-reset').click();
    await expect.poll(() => settingsFile(userData)).not.toContain('copyOnSelect');
    await expect(copy).toHaveAttribute('data-modified', 'false');

    // Plugin settings come from contributes.configuration and are validated against it.
    await win.locator('[data-testid="settings-section"][data-section="Usage Monitor"]').click();
    const retention = row(win, 'usage.retentionDays').getByTestId('setting-control');
    await expect(retention).toHaveValue('400');
    await retention.fill('0');
    await retention.press('Enter');
    await expect(win.locator('[data-sonner-toast]').filter({ hasText: 'Minimum is 1' })).toBeVisible();
    await retention.fill('90');
    await retention.press('Enter');
    await expect.poll(() => settingsFile(userData)).toContain('"usage.retentionDays": 90');
    await row(win, 'usage.weekStartsOn').getByTestId('setting-control').selectOption({ label: 'Sunday' });
    await expect.poll(() => settingsFile(userData)).toContain('"usage.weekStartsOn": "sunday"');

    // @modified lists what differs from the defaults; external edits show up live.
    await win.getByTestId('settings-search').fill('@modified');
    await expect
      .poll(async () =>
        (
          await win.getByTestId('setting-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key')))
        ).sort(),
      )
      .toEqual(
        [
          'git.periodicRefreshSeconds',
          'terminal.cursorStyle',
          'terminal.fontSize',
          'usage.retentionDays',
          'usage.weekStartsOn',
        ].sort(),
      );
    const text = await settingsFile(userData);
    await writeFile(file, text.replace('"git.periodicRefreshSeconds": 20', '"git.periodicRefreshSeconds": 45'));
    await expect(row(win, 'git.periodicRefreshSeconds').getByTestId('setting-control')).toHaveValue('45');

    // Structured values are read-only here; "Open settings.json" opens the file in the editor.
    await win.getByTestId('settings-search').fill('terminal env');
    await expect(row(win, 'terminal.env').locator('pre')).toHaveText('{}');
    await win.getByTestId('settings-open-file').click();
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

test('Settings opens from the app menu and the command palette', async () => {
  const { app, win } = await launchApp();
  try {
    await waitForTerminal(win);
    await win.getByTestId('app-menu').click();
    await win.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(win.getByTestId('settings-panel')).toBeVisible();
    await expect(win.locator('[data-testid="settings-section"][data-section="All"]')).toBeVisible();
    await win.getByTestId('settings-panel').getByTestId('settings-search').fill('');
    // Ctrl+, (outside terminals) focuses the existing panel instead of opening a second one.
    await win.getByTestId('settings-search').press('Control+Comma');
    await expect(win.getByTestId('settings-panel')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
