import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

async function folder(name: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-projects-')), name);
  await mkdir(dir);
  return dir;
}

const answerPickFolder = (app: ElectronApplication, path: string | null) =>
  app.evaluate((_e, p) => {
    (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] = p;
  }, path);

test('the welcome screen adds the first project', async () => {
  const { app, win } = await launchApp({ project: null });
  try {
    await expect(win.getByTestId('welcome')).toBeVisible();
    await answerPickFolder(app, await folder('first-app'));
    await win.getByRole('button', { name: 'Add project' }).first().click();
    await expect(win.getByTestId('projects-item-first-app')).toHaveAttribute('aria-selected', 'true');
    const id = await waitForTerminal(win);
    await run(win, nodeCmd('console.log(process.cwd())'));
    await expect.poll(() => oxyTest(win).text(id)).toContain('first-app');
  } finally {
    await app.close();
  }
});

test('switching projects shows each project its own terminals', async () => {
  const { app, win } = await launchApp({ project: await folder('alpha') });
  try {
    const alphaTerminal = await waitForTerminal(win);
    await run(win, nodeCmd("console.log('in-' + 'alpha')"));
    await expect.poll(() => oxyTest(win).text(alphaTerminal)).toContain('in-alpha');

    await answerPickFolder(app, await folder('beta'));
    await win.getByRole('button', { name: 'Add project' }).click();
    await expect(win.getByTestId('projects-item-beta')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels[0]?.terminalId).not.toBe(alphaTerminal);

    await win.keyboard.press('Control+Alt+Digit1');
    await expect(win.getByTestId('projects-item-alpha')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await oxyTest(win).workspace())?.panels[0]?.terminalId).toBe(alphaTerminal);
    await expect.poll(() => oxyTest(win).text(alphaTerminal)).toContain('in-alpha');
  } finally {
    await app.close();
  }
});

test('removing a project asks whether to close its terminals', async () => {
  const { app, win } = await launchApp({ project: await folder('gamma') });
  try {
    await waitForTerminal(win);
    await win.getByTestId('projects-item-gamma').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Remove from Oxytocin…' }).click();
    const dialog = win.getByRole('alertdialog');
    await expect(dialog).toContainText('Remove ‘gamma’ from Oxytocin?');
    await expect(dialog.getByRole('checkbox', { name: 'Also close its 1 terminal' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(win.getByTestId('projects-item-gamma')).toHaveCount(0);
    await expect(win.getByTestId('welcome')).toBeVisible();
    await expect
      .poll(async () => ((await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as unknown[]).length)
      .toBe(0);
  } finally {
    await app.close();
  }
});

test('projects can be renamed and pinned', async () => {
  const { app, win } = await launchApp({ project: await folder('delta') });
  try {
    await waitForTerminal(win);
    await win.getByTestId('projects-item-delta').getByText('delta').dblclick();
    await win.getByTestId('project-rename-input').fill('Delta API');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('projects-item-Delta API')).toBeVisible();
    await win.getByTestId('projects-item-Delta API').click({ button: 'right' });
    await win.getByRole('menuitem', { name: 'Pin' }).click();
    await expect(win.getByTestId('projects-item-Delta API').getByLabel('Pinned')).toBeVisible();

    // Rename from the context menu (typing in a terminal before): the field stays open and focused after the
    // menu closed and gave the focus back.
    await win.locator('.xterm').first().click();
    const row = (await win.getByTestId('projects-item-Delta API').boundingBox())!;
    await win.mouse.move(row.x + 30, row.y + row.height / 2);
    await win.mouse.down({ button: 'right' });
    await win.mouse.up({ button: 'right' });
    const item = (await win.getByRole('menuitem', { name: 'Rename' }).boundingBox())!;
    await win.mouse.move(item.x + 10, item.y + item.height / 2, { steps: 5 });
    await win.mouse.down();
    await win.mouse.up();
    const input = win.getByTestId('project-rename-input');
    await expect(input).toBeFocused();
    await win.waitForTimeout(1000);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await win.keyboard.type('Delta Web');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('projects-item-Delta Web')).toBeVisible();
  } finally {
    await app.close();
  }
});
