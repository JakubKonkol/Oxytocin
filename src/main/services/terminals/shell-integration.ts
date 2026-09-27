import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ShellType } from './profiles';

/** Installed layout (relative to the integration directory) ← source file in resources/shell-integration. */
export const SHELL_INTEGRATION_FILES: Readonly<Record<string, string>> = {
  'bash.sh': 'bash.sh',
  'pwsh.ps1': 'pwsh.ps1',
  'zsh/.zshenv': 'zsh-zshenv.zsh',
  'zsh/.zprofile': 'zsh-zprofile.zsh',
  'zsh/.zshrc': 'zsh-zshrc.zsh',
  'zsh/.zlogin': 'zsh-zlogin.zsh',
  'zsh/oxytocin.zsh': 'zsh-integration.zsh',
  // fish reads $XDG_DATA_DIRS/fish/vendor_conf.d/*.fish.
  'fish/fish/vendor_conf.d/oxytocin.fish': 'fish.fish',
};

export interface ShellIntegrationScripts {
  /** Directory with the installed scripts (userData/shell-integration). */
  dir: string;
  /** PowerShell script text (passed with -EncodedCommand: not subject to the execution policy). */
  pwsh: string;
}

/**
 * Copies the scripts from the app resources into `targetDir` (dotfiles for zsh, a vendor_conf.d tree for fish;
 * paths without spaces or asar). Files are rewritten only when their content changed.
 */
export async function installShellIntegration(sourceDir: string, targetDir: string): Promise<ShellIntegrationScripts> {
  let pwsh = '';
  for (const [target, source] of Object.entries(SHELL_INTEGRATION_FILES)) {
    const text = await readFile(join(sourceDir, source), 'utf8');
    if (target === 'pwsh.ps1') pwsh = text;
    const path = join(targetDir, target);
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === text) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return { dir: targetDir, pwsh };
}

export interface InjectionInput {
  shellType: ShellType;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  scripts: ShellIntegrationScripts;
  platform: NodeJS.Platform;
}

export interface Injection {
  args: string[];
  env: Record<string, string>;
  injected: boolean;
}

const LOGIN_FLAGS = new Set(['-l', '--login']);

/** Arguments that make a shell run something else than an interactive session (then nothing is injected). */
function runsScript(args: readonly string[], shellType: ShellType): boolean {
  if (shellType === 'pwsh' || shellType === 'powershell') {
    return args.some(
      (a) => /^[-/](c|command|f|file|e|ec|encodedcommand|noninteractive)$/i.test(a) || /^-(com|fil|enc)/i.test(a),
    );
  }
  return args.some(
    (a) =>
      a === '-c' || a === '--rcfile' || a === '--init-file' || a === '--norc' || a === '--posix' || !a.startsWith('-'),
  );
}

const sep = (platform: NodeJS.Platform) => (platform === 'win32' ? '\\' : '/');

/**
 * Shell integration injection (docs/plan/04-terminals.md §11): bash `--init-file` (a login shell's `-l` is
 * emulated by the script), zsh `ZDOTDIR`, fish `XDG_DATA_DIRS`, PowerShell `-NoExit -EncodedCommand`.
 * cmd, Git Bash, WSL and unknown shells run unchanged.
 */
export function injectShellIntegration(input: InjectionInput): Injection {
  const { shellType, args, env, scripts, platform } = input;
  const none: Injection = { args: [...args], env: { ...env }, injected: false };
  if (runsScript(args, shellType)) return none;
  const path = (rel: string) => [scripts.dir, ...rel.split('/')].join(sep(platform));
  switch (shellType) {
    case 'bash': {
      const login = args.some((a) => LOGIN_FLAGS.has(a));
      return {
        args: ['--init-file', path('bash.sh'), ...args.filter((a) => !LOGIN_FLAGS.has(a))],
        env: { ...env, ...(login ? { OXYTOCIN_SHELL_LOGIN: '1' } : {}) },
        injected: true,
      };
    }
    case 'zsh':
      return {
        args: [...args],
        env: { ...env, ZDOTDIR: path('zsh'), USER_ZDOTDIR: env['ZDOTDIR'] || env['HOME'] || '' },
        injected: true,
      };
    case 'fish': {
      const original = env['XDG_DATA_DIRS'] ?? '';
      return {
        args: [...args],
        env: {
          ...env,
          XDG_DATA_DIRS: [path('fish'), original || '/usr/local/share:/usr/share'].join(':'),
          OXYTOCIN_XDG_DATA_DIRS: original,
        },
        injected: true,
      };
    }
    case 'pwsh':
    case 'powershell': {
      if (!scripts.pwsh) return none;
      const encoded = Buffer.from(scripts.pwsh, 'utf16le').toString('base64');
      return {
        args: [...args.filter((a) => !/^-noexit$/i.test(a)), '-NoExit', '-EncodedCommand', encoded],
        env: { ...env },
        injected: true,
      };
    }
    default:
      return none;
  }
}
