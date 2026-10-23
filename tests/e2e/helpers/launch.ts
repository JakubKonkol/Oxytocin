import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { defaultUiState } from '../../../src/shared/domain/ui-state';

export interface LaunchOptions {
  userData?: string;
  /**
   * Folder passed on the command line as a project. Defaults to a fresh temporary folder on first launches
   * (a new userData dir); `null` starts without one (welcome screen). Restarts (explicit userData) pass none.
   */
  project?: string | null;
  env?: Record<string, string>;
  args?: string[];
  /**
   * Opens the right sidebar (scratchpad) on a fresh profile. Off by default: CI screens are small (1024×768 on
   * Windows runners) and the extra column would narrow the terminals until prompts and commands wrap.
   */
  secondarySidebar?: boolean;
}

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  userData: string;
  project: string | null;
}

export const repoRoot = resolve(__dirname, '../../..');

/**
 * The test runner's environment without what would make the app behave differently on the machine running the
 * tests: AI agent configuration (an API base URL, keys, a Claude Code session the tests run inside of). Tests that
 * need such a variable pass it in `env`.
 */
export function hermeticEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|GEMINI_|GOOGLE_(API|GENAI|CLOUD))/i.test(key))
      env[key] = value;
  return env;
}

/** Launches the built app (out/) with an isolated userData directory. */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const userData = opts.userData ?? (await mkdtemp(join(tmpdir(), 'oxy-e2e-')));
  const project =
    opts.project !== undefined
      ? opts.project
      : opts.userData
        ? null
        : await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  const uiStateFile = join(userData, 'ui-state.json');
  if (
    !(await access(uiStateFile).then(
      () => true,
      () => false,
    ))
  ) {
    const ui = defaultUiState();
    ui.secondarySidebar.collapsed = !opts.secondarySidebar;
    await writeFile(uiStateFile, JSON.stringify(ui));
  }
  // Chromium's OS-level sandbox is unavailable in Linux containers/CI runners (root, AppArmor userns).
  const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  // Packaged smoke tests run the installed/unpacked app instead of out/ (OXYTOCIN_EXECUTABLE).
  const executablePath = process.env['OXYTOCIN_EXECUTABLE'];
  const fixtureHome = opts.env?.['HOME'] || opts.env?.['USERPROFILE'];
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
    // No prefers-color-scheme emulation: the app's theme follows nativeTheme (appearance.theme).
    colorScheme: null,
    env: {
      ...hermeticEnv(),
      OXYTOCIN_E2E: '1',
      // A default E2E instance must not read real usage or install/remove the user's Claude status line.
      // Tests with an explicit fixture home keep deriving the CLI folders from that home as before.
      CLAUDE_CONFIG_DIR: fixtureHome ? '' : join(userData, 'agent-homes', 'claude'),
      CODEX_HOME: fixtureHome ? join(fixtureHome, '.codex') : join(userData, 'agent-homes', 'codex'),
      GEMINI_CLI_HOME: fixtureHome || join(userData, 'agent-homes', 'gemini'),
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, userData, project };
}
