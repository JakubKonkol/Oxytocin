import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

interface ProjectLite {
  id: string;
  name: string;
  color: number;
  icon?: { kind: string; value: string };
  settings: { env?: Record<string, string | null>; startupTerminals?: unknown[]; git?: unknown };
}

test('project settings: name, color, icon, environment with stale terminals, startup terminals and validation', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-ps-')), 'alpha');
  await mkdir(project);
  const { app, win } = await launchApp({ project });
  try {
    const t = oxyTest(win);
    const first = await waitForTerminal(win);
    const id = await activeProjectId(win);

    await win.getByTestId('projects-item-alpha').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    const dialog = win.getByTestId('project-settings');
    await expect(dialog).toBeVisible();

    await dialog.getByTestId('project-settings-name').fill('Alpha API');
    await dialog.getByTestId('project-color-5').click();
    await dialog.getByTestId('project-settings-icon').fill('A');
    await dialog.getByTestId('project-settings-tab-environment').click();
    await dialog.getByRole('button', { name: 'Add variable' }).click();
    const row = dialog.getByTestId('project-env-row').first();
    await row.getByLabel('Variable name').fill('OXY_PROJECT_VAR');
    await row.getByLabel('Value').fill('from-settings');
    await expect(dialog.getByTestId('project-env-note')).toBeVisible();
    await dialog.getByTestId('project-settings-tab-terminals').click();
    await dialog.getByRole('button', { name: 'Add terminal' }).click();
    const startup = dialog.getByTestId('project-startup-row').first();
    await startup.getByLabel('Name').fill('Dev');
    await startup.getByLabel('Command').fill('npm run dev');
    await dialog.getByTestId('project-settings-tab-git').click();
    await dialog.getByTestId('project-settings-ignored').fill('tmp\nlogs');
    await dialog.getByTestId('project-settings-tab-terminals').click();

    // Invalid input blocks saving.
    await startup.getByLabel('Folder').fill('../outside');
    await expect(dialog.getByTestId('project-settings-problems')).toContainText('must be inside the project');
    await expect(dialog.getByTestId('project-settings-save')).toBeDisabled();
    await startup.getByLabel('Folder').fill('web');
    await dialog.getByTestId('project-settings-save').click();
    await expect(dialog).toHaveCount(0);

    const saved = ((await win.evaluate(() => window.oxy.invoke('projects:list'))) as ProjectLite[]).find(
      (p) => p.id === id,
    )!;
    expect(saved).toMatchObject({
      name: 'Alpha API',
      color: 5,
      icon: { kind: 'letter', value: 'A' },
      settings: {
        env: { OXY_PROJECT_VAR: 'from-settings' },
        startupTerminals: [{ name: 'Dev', command: 'npm run dev', cwd: 'web' }],
        git: { ignoredFolders: ['tmp', 'logs'] },
      },
    });
    await expect(win.getByTestId('projects-item-Alpha API')).toBeVisible();

    // The running terminal is out of date; a new one gets the variable.
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as { id: string; envStale: boolean }[]
          ).find((x) => x.id === first)?.envStale,
      )
      .toBe(true);
    await win.keyboard.press('Control+Shift+KeyT');
    await expect.poll(async () => (await t.workspace())?.panels.length).toBe(2);
    const second = (await t.workspace())!.panels.find((p) => p.terminalId !== first)!.terminalId!;
    await expect.poll(() => t.text(second)).not.toBe('');
    await run(win, nodeCmd("console.log('var=' + process.env.OXY_PROJECT_VAR)"));
    await expect.poll(() => t.text(second)).toContain('var=from-settings');

    // Reopened from the command palette, the dialog shows the saved values.
    await win.keyboard.press('Control+Shift+KeyP');
    await win.keyboard.type('project settings');
    await win.keyboard.press('Enter');
    await expect(dialog.getByTestId('project-settings-name')).toHaveValue('Alpha API');
    await dialog.getByTestId('project-settings-tab-environment').click();
    await expect(dialog.getByTestId('project-env-row').first().getByLabel('Value')).toHaveValue('from-settings');
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Unsaved changes: Escape asks before discarding them.
    await win.getByTestId('projects-item-Alpha API').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await dialog.getByTestId('project-settings-name').fill('Changed');
    await win.keyboard.press('Escape');
    await expect(win.getByRole('alertdialog')).toContainText('Discard your changes?');
    await win.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await app.close();
  }
});
