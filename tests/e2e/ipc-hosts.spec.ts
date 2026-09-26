import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

interface MainHooks {
  hosts: {
    status(): { name: string; state: string; pid: number | null; restarts: number }[];
    pty: { kill(): void };
  };
  logFile(): string;
}

test('the renderer receives app info over IPC', async () => {
  const { app, win } = await launchApp();
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible();
    const info = await win.evaluate(() => window.oxy.invoke('app:getInfo'));
    expect(info).toMatchObject({ name: expect.any(String), e2e: true });
    const versions = (info as { versions: { electron: string; node: string } }).versions;
    expect(versions.electron).toMatch(/^44\./);
    expect(versions.node).toMatch(/^24\./);
  } finally {
    await app.close();
  }
});

test('blocked channels and invalid payloads are rejected', async () => {
  const { app, win } = await launchApp();
  try {
    const blocked = await win.evaluate(() => window.oxy.invoke('fs:deleteEverything').catch((e: Error) => e.message));
    expect(blocked).toContain('Blocked IPC channel');
    const invalid = await win.evaluate(() =>
      window.oxy.invoke('settings:get', { x: 1 }).catch((e: Error) => e.message),
    );
    expect(invalid).toContain('"code":"INVALID"');
  } finally {
    await app.close();
  }
});

test('a killed utility host is restarted and the restart is logged', async () => {
  const { app } = await launchApp();
  try {
    const running = async () =>
      app.evaluate(() => (globalThis as unknown as { __oxyMain: MainHooks }).__oxyMain.hosts.status());
    await expect.poll(async () => (await running()).every((h) => h.state === 'running')).toBe(true);
    const before = (await running()).find((h) => h.name === 'Oxytocin PTY Host');
    await app.evaluate(() => (globalThis as unknown as { __oxyMain: MainHooks }).__oxyMain.hosts.pty.kill());
    await expect
      .poll(async () => (await running()).find((h) => h.name === 'Oxytocin PTY Host'), { timeout: 10_000 })
      .toMatchObject({ state: 'running', restarts: 1 });
    const after = (await running()).find((h) => h.name === 'Oxytocin PTY Host');
    expect(after?.pid).not.toBe(before?.pid);
    const logFile = await app.evaluate(() => (globalThis as unknown as { __oxyMain: MainHooks }).__oxyMain.logFile());
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('Oxytocin PTY Host exited unexpectedly');
    expect(log).toContain('Oxytocin PTY Host restarted');
    expect(log).toContain('[pty] PTY Host started');
  } finally {
    await app.close();
  }
});
