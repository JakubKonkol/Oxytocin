import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId } from './helpers/terminal';
import { userDataWithPlugins } from './helpers/plugins';

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
