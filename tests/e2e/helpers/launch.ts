import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchOptions {
  userData?: string;
  env?: Record<string, string>;
  args?: string[];
}

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  userData: string;
}

export const repoRoot = resolve(__dirname, '../../..');

/** Launches the built app (out/) with an isolated userData directory. */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = opts.userData ?? (await mkdtemp(join(tmpdir(), 'oxy-e2e-')));
  // Chromium's OS-level sandbox is unavailable in Linux containers/CI runners (root, AppArmor userns).
  const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const app = await electron.launch({
    args: [join(repoRoot, 'out/main/index.js'), ...platformArgs, `--user-data-dir=${userData}`, ...(opts.args ?? [])],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      OXYTOCIN_E2E: '1',
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, userData };
}
