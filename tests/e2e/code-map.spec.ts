import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId } from './helpers/terminal';

test('Code Map settings build, update, pause, rebuild, preserve settings and delete disabled data', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-map-ui-')), 'map-project');
  await mkdir(project);
  await promisify(execFile)('git', ['--no-optional-locks', 'init'], { cwd: project, windowsHide: true });
  await writeFile(join(project, 'api.ts'), 'export function first() { return 1 }\n');
  const { app, win } = await launchApp({ project });
  try {
    const id = await activeProjectId(win);
    const map = join(project, '.oxy/code-map');
    const graph = async () =>
      JSON.parse(await readFile(join(map, 'graph.json'), 'utf8')) as {
        files: { path: string }[];
        symbols: { name: string }[];
      };
    await win.getByTestId('projects-item-map-project').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    const dialog = win.getByTestId('project-settings');
    await dialog.getByTestId('project-settings-tab-code-map').click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Disabled');
    await dialog.getByTestId('code-map-enabled').click();
    const confirm = win
      .getByRole('alertdialog')
      .filter({ has: win.getByRole('heading', { name: 'Enable Code Map?' }) });
    await expect(confirm.getByRole('checkbox')).toBeChecked();
    await confirm.getByRole('button', { name: 'Enable Code Map', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready', { timeout: 20_000 });
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toContain('/.oxy/');
    expect((await graph()).symbols.map((s) => s.name)).toContain('first');
    await dialog.getByRole('button', { name: 'Copy agent instructions' }).click();
    expect(((await win.evaluate(() => window.oxy.invoke('clipboard:read'))) as { text: string }).text).toContain(
      'MAP.md',
    );
    await writeFile(join(project, 'api.ts'), 'export function second() { return 2 }\n');
    await expect.poll(async () => (await graph()).symbols.map((s) => s.name)).toContain('second');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByRole('button', { name: 'Pause updates', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Paused');
    const paused = await readFile(join(map, 'graph.json'), 'utf8');
    await writeFile(join(project, 'api.ts'), 'export function resumed() { return 3 }\n');
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
              pendingFiles: number;
            }
          ).pendingFiles,
      )
      .toBeGreaterThan(0);
    expect(await readFile(join(map, 'graph.json'), 'utf8')).toBe(paused);
    await dialog.getByRole('button', { name: 'Resume updates', exact: true }).click();
    await expect.poll(async () => (await graph()).symbols.map((s) => s.name)).toContain('resumed');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByRole('button', { name: 'Rebuild', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    expect(await readFile(join(map, 'MAP.md'), 'utf8')).toContain('resumed');
    await dialog.getByTestId('code-map-ignore-git').click();
    await win.getByRole('button', { name: 'Change Git preference', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await expect.poll(() => readFile(join(project, '.gitignore'), 'utf8')).not.toContain('/.oxy/');
    const { stdout } = await promisify(execFile)(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'],
      { cwd: project, windowsHide: true },
    );
    expect(stdout).toContain('.oxy/code-map/graph.json');
    expect(stdout).not.toContain('manifest.json');
    expect(stdout).not.toContain('/cache/');
    await dialog.getByTestId('code-map-ignore-git').click();
    await expect.poll(() => readFile(join(project, '.gitignore'), 'utf8')).toContain('/.oxy/');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByLabel('Excluded paths').fill('generated/**');
    await dialog.getByRole('button', { name: 'Apply exclusions' }).click();
    await expect(dialog.getByRole('button', { name: 'Apply exclusions' })).toBeDisabled();
    await dialog.getByTestId('project-settings-tab-general').click();
    await dialog.getByTestId('project-settings-name').fill('Map renamed');
    await dialog.getByTestId('project-settings-save').click();
    const saved = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as {
      id: string;
      settings: { codeMap: unknown };
    }[];
    expect(saved.find((p) => p.id === id)?.settings.codeMap).toEqual({
      enabled: true,
      excludedPaths: ['generated/**'],
      ignoreInGit: true,
    });
    await win.getByRole('button', { name: 'Code Map status' }).click();
    await expect(dialog.getByTestId('code-map-tab')).toBeVisible();
    await dialog.getByRole('button', { name: 'Show diagnostics' }).click();
    await expect(dialog.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open MAP.md', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(win.getByTestId('code-panel')).toContainText('Code Map');
    await win.getByRole('button', { name: 'Code Map status' }).click();
    await dialog.getByTestId('code-map-enabled').click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Disabled');
    const disabled = await readFile(join(map, 'graph.json'), 'utf8');
    await writeFile(join(project, 'api.ts'), 'export function disabled() {}\n');
    // A disabled map has no watcher/periodic worker and retains its last generation.
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate(() => window.oxy.invoke('app:getHostStatus'))) as { name: string; state: string }[]
          ).find((h) => h.name === 'Oxytocin Code Map Host')?.state,
      )
      .toBe('stopped');
    expect(await readFile(join(map, 'graph.json'), 'utf8')).toBe(disabled);
    await dialog.getByRole('button', { name: 'Delete map data', exact: true }).click();
    await win
      .getByRole('alertdialog')
      .filter({ has: win.getByRole('heading', { name: 'Delete map data?' }) })
      .getByRole('button', { name: 'Delete map data', exact: true })
      .click();
    await expect
      .poll(() =>
        stat(map).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  } finally {
    await app.close();
  }
});

for (const git of [false, true])
  test(`enabling with Git ignore unchecked respects ${git ? 'Git' : 'non-Git'} folders`, async () => {
    const project = await mkdtemp(join(tmpdir(), 'oxy-map-optout-'));
    if (git) await promisify(execFile)('git', ['--no-optional-locks', 'init'], { cwd: project, windowsHide: true });
    await writeFile(join(project, 'index.ts'), 'export const hello = () => 1;\n');
    const { app, win } = await launchApp({ project });
    try {
      const id = await activeProjectId(win);
      await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
      await win.getByTestId('project-menu-settings').click();
      await win.getByTestId('project-settings-tab-code-map').click();
      await win.getByTestId('code-map-enabled').click();
      const confirmation = win.getByRole('alertdialog', { name: 'Enable Code Map?' });
      await confirmation.getByRole('checkbox').uncheck();
      await confirmation.getByRole('button', { name: 'Enable Code Map', exact: true }).click();
      await expect
        .poll(
          async () =>
            (
              (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
                state: string;
              }
            ).state,
        )
        .toBe('ready');
      await expect(stat(join(project, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(project, '.oxy/.gitignore'), 'utf8')).toContain('/code-map/cache/');
      await win.evaluate((projectId) => window.oxy.invoke('codeMap:deleteData', { projectId }), id);
      await expect(stat(join(project, '.oxy/code-map'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.close();
    }
  });
