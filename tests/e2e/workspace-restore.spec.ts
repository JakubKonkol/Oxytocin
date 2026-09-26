import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('layout, titles and scrollback survive an app restart', async () => {
  const first = await launchApp();
  const { userData } = first;
  const captured = { panelIds: [] as string[], projectId: '' };
  try {
    const t = oxyTest(first.win);
    const id = await waitForTerminal(first.win);
    await run(first.win, nodeCmd("console.log('remember-' + 'this')"));
    await expect.poll(() => t.text(id)).toContain('remember-this');
    await first.win.keyboard.press('Alt+Shift+Minus');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(2);
    const second = (await t.workspace())!.panels.find((p) => p.terminalId !== id)!;
    await first.win.getByTestId(`tab-${second.id}`).getByTestId('tab-title').dblclick();
    await first.win.getByTestId('tab-rename-input').fill('Logs');
    await first.win.keyboard.press('Enter');
    await expect(first.win.getByTestId(`tab-${second.id}`)).toContainText('Logs');
    captured.panelIds = (await t.workspace())!.panels.map((p) => p.id).sort();
    captured.projectId = await activeProjectId(first.win);
  } finally {
    await first.app.close();
  }
  expect(await readdir(join(userData, 'workspaces', captured.projectId, 'scrollback'))).toHaveLength(2);

  const second = await launchApp({ userData });
  try {
    const t = oxyTest(second.win);
    await waitForTerminal(second.win);
    await expect.poll(async () => (await t.workspace())?.panels.map((p) => p.id).sort()).toEqual(captured.panelIds);
    const ws = (await t.workspace())!;
    expect(ws.groups).toBe(2);
    const restoredText = async () =>
      (await Promise.all(ws.panels.map((p) => t.text(p.terminalId!)))).find((x) => x.includes('remember-this')) ?? '';
    await expect.poll(restoredText).toMatch(/remember-this[\s\S]*── Session restored · .+ ──/);
    await expect(second.win.getByTestId('tab-title').filter({ hasText: 'Logs' })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('a corrupt layout file falls back to the default layout with a warning', async () => {
  const first = await launchApp();
  await waitForTerminal(first.win);
  const projectId = await activeProjectId(first.win);
  await first.app.close();
  await writeFile(join(first.userData, 'workspaces', `${projectId}.json`), '{ not json');

  const second = await launchApp({ userData: first.userData });
  try {
    await waitForTerminal(second.win);
    await expect(second.win.getByText('The saved layout could not be read')).toBeVisible();
    expect((await oxyTest(second.win).workspace())?.panels).toHaveLength(1);
  } finally {
    await second.app.close();
  }
});

test('an unknown panel type is restored as a placeholder', async () => {
  const first = await launchApp();
  await waitForTerminal(first.win);
  const projectId = await activeProjectId(first.win);
  await first.app.close();
  const file = join(first.userData, 'workspaces', `${projectId}.json`);
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')) as {
    dockview: { panels: Record<string, { contentComponent: string; params?: unknown }> };
    panels: Record<string, unknown>;
  };
  const [panelId] = Object.keys(state.dockview.panels);
  state.dockview.panels[panelId!]!.contentComponent = 'plugin';
  state.panels[panelId!] = { kind: 'plugin', pluginId: 'gone.plugin', panelType: 'x' };
  await writeFile(file, JSON.stringify(state));

  const second = await launchApp({ userData: first.userData });
  try {
    await expect(second.win.getByTestId('missing-panel')).toContainText('Panel type "plugin" is unavailable');
  } finally {
    await second.app.close();
  }
});
