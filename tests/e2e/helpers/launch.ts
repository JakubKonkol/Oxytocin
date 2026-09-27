import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchOptions {
  userData?: string;
  /**
   * Folder passed on the command line as a project. Defaults to a fresh temporary folder on first launches
   * (a new userData dir); `null` starts without one (welcome screen). Restarts (explicit userData) pass none.
   */
  project?: string | null;
  env?: Record<string, string>;
  args?: string[];
}

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  userData: string;
  project: string | null;
}

export const repoRoot = resolve(__dirname, '../../..');

/** Launches the built app (out/) with an isolated userData directory. */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = opts.userData ?? (await mkdtemp(join(tmpdir(), 'oxy-e2e-')));
  const project =
    opts.project !== undefined
      ? opts.project
      : opts.userData
        ? null
        : await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  // Chromium's OS-level sandbox is unavailable in Linux containers/CI runners (root, AppArmor userns).
  const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  // Packaged smoke tests run the installed/unpacked app instead of out/ (OXYTOCIN_EXECUTABLE).
  const executablePath = process.env['OXYTOCIN_EXECUTABLE'];
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...(executablePath ? [] : [join(repoRoot, 'out/main/index.js')]),
      ...platformArgs,
      `--user-data-dir=${userData}`,
      ...(project ? [project] : []),
      ...(opts.args ?? []),
    ],
    cwd: executablePath ? tmpdir() : repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      OXYTOCIN_E2E: '1',
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, userData, project };
}
