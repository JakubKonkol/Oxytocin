import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId } from './helpers/terminal';
import { userDataWithPlugins } from './helpers/plugins';
import { claudeConfigDir, ensembleRecords, gitIn, gitRepo, useFakeClaude } from './helpers/ensemble';

test('visualizer explores a symbol by keyboard, opens source and updates after edits', async () => {
  const project = await mkdtemp(join(tmpdir(), 'oxy-map-view-'));
  await writeFile(join(project, 'api.ts'), 'export function visualizerApi() {}\n');
  const userData = await userDataWithPlugins([], { 'editor.preset': 'oxytocin' });
  const { app, win } = await launchApp({ project, userData });
  try {
    const id = await activeProjectId(win);
    await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true }), id);
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
    await win.evaluate(
      (projectId) => window.oxy.invoke('plugins:executeCommand', { id: 'codeMap.open', args: [projectId] }),
      id,
    );
    const frame = win.frameLocator('iframe[src*="oxytocin.code-map-visualizer"]');
    await expect(frame.getByRole('heading', { name: /Code Map/ })).toBeVisible();
    await frame.getByRole('checkbox', { name: 'List only', exact: true }).check();
    await frame.getByRole('textbox', { name: 'Search code' }).fill('visualizerApi');
    await frame.getByRole('button', { name: 'Find', exact: true }).click();
    const symbol = frame.getByRole('button', { name: 'visualizerApi', exact: true });
    await expect(symbol).toBeVisible();
    await symbol.focus();
    await win.keyboard.press('Enter');
    await frame.getByRole('button', { name: 'Explore one step' }).click();
    await symbol.click();
    await frame.getByRole('button', { name: 'Open in editor' }).click();
    await expect(win.getByTestId('code-panel')).toContainText('visualizerApi');
    await writeFile(join(project, 'api.ts'), 'export function visualizerChanged() {}\n');
    // The source opened as a tab in front of the visualizer.
    await win.locator('.dv-tab').filter({ hasText: 'Code Map' }).click();
    await frame.getByRole('textbox', { name: 'Search code' }).fill('visualizerChanged');
    await frame.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(frame.getByRole('button', { name: 'visualizerChanged', exact: true })).toBeVisible();
    await win.evaluate(() =>
      window.oxy.invoke('plugins:setEnabled', { id: 'oxytocin.code-map-visualizer', enabled: false }),
    );
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
  } finally {
    await app.close();
  }
});

test('Changes and Impact show bounded incoming dependencies and compare an Ensemble checkout with its base', async () => {
  test.setTimeout(180_000);
  const repo = await gitRepo();
  await writeFile(join(repo, 'api.ts'), 'export function api() { return 1; }\n');
  await writeFile(join(repo, 'main.ts'), "import { api } from './api';\nexport function main() { return api(); }\n");
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-qm', 'code fixture');
  const claude = await claudeConfigDir();
  const userData = await userDataWithPlugins([], { 'editor.preset': 'oxytocin' });
  const { app, win } = await launchApp({ project: repo, userData, env: { CLAUDE_CONFIG_DIR: claude.dir } });
  try {
    const id = await activeProjectId(win);
    await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true }), id);
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
    gitIn(repo, 'add', '.gitignore');
    gitIn(repo, 'commit', '-qm', 'ignore generated data');
    await writeFile(join(repo, 'api.ts'), 'export function api() { return 2; }\n');
    await win.evaluate(
      (projectId) => window.oxy.invoke('plugins:executeCommand', { id: 'codeMap.open', args: [projectId] }),
      id,
    );
    const frame = win.frameLocator('iframe[src*="oxytocin.code-map-visualizer"]');
    await frame.getByRole('checkbox', { name: 'List only', exact: true }).check();
    await frame.getByRole('button', { name: 'Changes', exact: true }).click();
    const table = frame.getByRole('table', { name: 'Code Map nodes' });
    await expect(table.getByRole('row').filter({ hasText: 'api.ts' })).toContainText('Changed');
    await expect(table.getByRole('row').filter({ hasText: 'main.ts' })).toContainText('Potential dependent');
    await expect(frame.getByRole('note')).toContainText('not exhaustive');
    await table.getByRole('button', { name: /api.ts/ }).click();
    await frame.getByRole('button', { name: 'Show potential dependents', exact: true }).click();
    await expect(frame.getByRole('note')).toContainText('Potential dependents in indexed code');
    await expect(table).toContainText('main.ts');
    // Create a real registered worktree using only the deterministic fake CLI.
    gitIn(repo, 'add', 'api.ts');
    gitIn(repo, 'commit', '-qm', 'main change');
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="pipeline"]').click();
    await panel.getByTestId('ensemble-template-feature').click();
    await panel.getByTestId('ensemble-new-title').fill('Map checkout review');
    await panel.getByTestId('ensemble-new-description').fill('Review a committed API change in an isolated checkout.');
    await panel.getByTestId('ensemble-create').click();
    await panel.getByTestId('ensemble-start').click();
    await expect(panel.getByTestId('ensemble-open-gate')).toBeVisible({ timeout: 60_000 });
    const record = (await ensembleRecords(win))[0]!;
    const worktree = record.run.worktree!.path;
    await writeFile(join(worktree, 'api.ts'), 'export function api() { return 3; }\n');
    gitIn(worktree, 'add', 'api.ts');
    gitIn(worktree, 'commit', '-qm', 'committed worktree change');
    await win.locator('.dv-tab').filter({ hasText: 'Code Map' }).click();
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
    await frame.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption(`worktree:${record.task.id}`);
    await frame.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(frame.getByRole('region', { name: 'Changed files' })).toContainText('Compared with worktree base');
    await expect(table.getByRole('row').filter({ hasText: 'api.ts' })).toContainText('Changed');
    await expect(table.getByRole('row').filter({ hasText: 'main.ts' })).toContainText('Potential dependent');
    await table.getByRole('button', { name: /api.ts/ }).click();
    await frame.getByRole('button', { name: 'Open in editor', exact: true }).click();
    await expect(win.getByTestId('code-panel')).toContainText('return 3');
    await win.locator('.dv-tab').filter({ hasText: 'Code Map' }).click();
    await frame.getByRole('combobox', { name: 'Checkout', exact: true }).selectOption(id);
    await frame.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(frame.getByRole('region', { name: 'Changed files' })).toContainText(
      'Uncommitted changes compared with HEAD',
    );
    await expect(frame.getByRole('region', { name: 'Changed files' })).not.toContainText('api.ts');
  } finally {
    await app.close();
  }
});
