import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

test('quitting with a running agent asks for confirmation', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  // A user-defined agent profile: the shell runs a long-lived node process as the "agent".
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
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    await win.evaluate(() => window.oxy.invoke('terminals:create', { projectId: 'default', profileId: 'agent:fake' }));
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = 'cancel';
    });
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await win.waitForTimeout(500);
    expect(await oxyTest(win).terminalIds()).not.toHaveLength(0);
    expect(app.windows()).toHaveLength(1);
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = 'quit';
    });
  } finally {
    await app.close();
  }
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the quit dialog lists running processes and quitting leaves no orphans', async () => {
  const { app, win } = await launchApp();
  const setAnswer = (answer: 'quit' | 'cancel') =>
    app.evaluate((_e, a) => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = a;
    }, answer);
  let pids: number[] = [];
  try {
    const id = await waitForTerminal(win);
    await run(win, nodeCmd('setInterval(() => {}, 1000)'));
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('PROCESS', { timeout: 10_000 });
    const list = (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as {
      id: string;
      pid: number;
      foreground?: { pid: number };
    }[];
    const info = list.find((t) => t.id === id)!;
    pids = [info.pid, info.foreground!.pid];

    await setAnswer('cancel');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await win.waitForTimeout(500);
    expect(app.windows()).toHaveLength(1);
    const prompt = await app.evaluate(() =>
      ((globalThis as Record<string, unknown>)['__oxyMain'] as { lastQuitPrompt: () => unknown }).lastQuitPrompt(),
    );
    expect(prompt).toMatchObject({
      message: expect.stringMatching(
        /^1 terminal has a running process \(node -e .* in ‘oxy-e2e-project-.+’\)\. Quit anyway\?$/,
      ),
      detail: expect.stringContaining('These processes will be stopped.'),
    });
    expect(pids.every(isAlive)).toBe(true);
  } finally {
    await setAnswer('quit');
    await app.close();
  }
  await expect.poll(() => pids.filter(isAlive), { timeout: 10_000 }).toEqual([]);
});

test("the quit confirmation is the app's own dialog", async () => {
  const { app, win, userData } = await launchApp();
  try {
    await waitForTerminal(win);
    await run(win, nodeCmd('setInterval(() => {}, 1000)'));
    await expect(win.getByTestId('terminal-kind-badge')).toHaveText('PROCESS', { timeout: 10_000 });
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = 'dialog';
    });
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    const dialog = win.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Quit Oxytocin?');
    await expect(dialog).toContainText('A terminal still runs a process. Quitting stops it.');
    await expect(dialog.getByTestId('confirm-dialog-details')).toContainText('node -e');
    // Cancel is focused: Enter does not quit by accident.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await win.waitForTimeout(300);
    expect(app.windows()).toHaveLength(1);

    // "Don't ask again" + Quit: the setting is turned off and the app quits.
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: "Don't ask again" }).check();
    const closed = app.waitForEvent('close');
    await dialog.getByRole('button', { name: 'Quit' }).click();
    await closed;
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toMatchObject({
      'terminal.confirmOnQuit': false,
    });
  } finally {
    await app.close().catch(() => undefined);
  }
});
