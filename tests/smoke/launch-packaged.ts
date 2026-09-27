import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';

export interface PackagedApp {
  win: Page;
  close: () => Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });

/**
 * Starts the installed/unpacked app like a user would and attaches over the Chrome DevTools Protocol. The fuses
 * of a release build disable Node's --inspect (Playwright's Electron launcher needs it), so the smoke test drives
 * the real, hardened binary through the renderer only.
 */
export async function launchPackaged(executable: string, project: string): Promise<PackagedApp> {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-smoke-'));
  const port = await freePort();
  const child: ChildProcess = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      project,
    ],
    { cwd: tmpdir(), env: { ...process.env, OXYTOCIN_E2E: '1' }, stdio: 'ignore' },
  );
  let browser: Browser | undefined;
  const deadline = Date.now() + 30_000;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill();
        throw e instanceof Error ? e : new Error(String(e));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  let win: Page | undefined;
  while (!win) {
    win = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith('app://'));
    if (!win) {
      if (Date.now() > deadline) throw new Error('The main window did not appear');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await win.waitForLoadState('domcontentloaded');
  return {
    win,
    close: async () => {
      await browser.close().catch(() => undefined);
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
