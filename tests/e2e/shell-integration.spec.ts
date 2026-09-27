import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId, nodeCmd, run, waitForTerminal } from './helpers/terminal';

interface Info {
  id: string;
  cwd: string;
  kind: string;
  shellIntegration?: boolean;
  command?: { commandLine?: string };
  lastCommand?: { commandLine?: string; exitCode?: number; durationMs: number };
}

const info = async (win: Page, id: string) =>
  ((await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as Info[]).find((t) => t.id === id);

const samePath = (a: string | undefined, b: string) =>
  process.platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b;

test('shell integration: cwd, command boundaries, exit codes, notifications and the initial command after the prompt', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'notifications.commandFinishedMinSeconds': 1 }));
  const project = await realpath(await mkdtemp(join(tmpdir(), 'oxy-e2e-si-')));
  const sub = join(project, 'sub dir');
  await mkdir(sub);
  const { app, win } = await launchApp({ userData, project });
  try {
    const id = await waitForTerminal(win);
    await expect.poll(async () => (await info(win, id))?.shellIntegration, { timeout: 15_000 }).toBe(true);

    // cwd from OSC 633;P (a folder name with a space).
    await run(win, `cd "${sub}"`);
    await expect.poll(async () => samePath((await info(win, id))?.cwd, sub)).toBe(true);

    // A running command is a PROCESS right away and reports its command line; the end brings the exit code.
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyWindowFocused'] = false;
    });
    await run(win, nodeCmd('setTimeout(() => process.exit(3), 3000)'));
    await expect.poll(async () => (await info(win, id))?.kind, { timeout: 2_500 }).toBe('process');
    expect((await info(win, id))?.command?.commandLine).toContain('setTimeout');
    await expect.poll(async () => (await info(win, id))?.lastCommand?.exitCode, { timeout: 10_000 }).toBe(3);
    const last = (await info(win, id))!.lastCommand!;
    expect(last.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(last.commandLine).toContain('process.exit(3)');
    await expect.poll(async () => (await info(win, id))?.kind).toBe('shell');
    // Longer than the threshold (1 s here) with the window unfocused: an OS notification.
    await expect
      .poll(() =>
        app.evaluate(() =>
          (
            (globalThis as Record<string, unknown>)['__oxyMain'] as { osNotifications: { title: string }[] }
          ).osNotifications.map((n) => n.title),
        ),
      )
      .toContain('Command failed (exit 3)');

    // The initial command of a new terminal is typed once the prompt is ready.
    const projectId = await activeProjectId(win);
    const created = (await win.evaluate(
      (p) => window.oxy.invoke('terminals:create', { projectId: p, initialCommand: 'echo init-after-prompt' }),
      projectId,
    )) as Info;
    await expect
      .poll(async () => (await info(win, created.id))?.lastCommand?.commandLine, { timeout: 15_000 })
      .toBe('echo init-after-prompt');
    expect((await info(win, created.id))?.lastCommand?.exitCode).toBe(0);
  } finally {
    await app.close();
  }
});

test('shell integration can be turned off', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'terminal.shellIntegration': false }));
  const { app, win } = await launchApp({ userData, project: await mkdtemp(join(tmpdir(), 'oxy-e2e-si-')) });
  try {
    const id = await waitForTerminal(win);
    await run(win, nodeCmd("console.log('plain-' + 'shell')"));
    await expect.poll(async () => (await info(win, id))?.lastCommand).toBeUndefined();
    await win.waitForTimeout(500);
    expect((await info(win, id))?.shellIntegration).toBeUndefined();
  } finally {
    await app.close();
  }
});
