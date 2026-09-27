import { execFile } from 'node:child_process';
import { access, constants, readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** I/O used by profile detection — injectable so detection logic is unit-testable. */
export interface DetectDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  isFile(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  /** Runs a command and returns stdout as a Buffer (null on failure / timeout). */
  exec(file: string, args: string[]): Promise<Buffer | null>;
}

/** `getEnv` is read lazily so detection sees the resolved login-shell environment once it is available. */
export function nodeDetectDeps(
  getEnv: () => Readonly<Record<string, string | undefined>> = () => process.env,
): DetectDeps {
  return {
    platform: process.platform,
    get env() {
      return getEnv();
    },
    async isFile(path) {
      try {
        const s = await stat(path);
        if (!s.isFile()) return false;
        if (process.platform !== 'win32') await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    exec(file, args) {
      return new Promise((resolve) => {
        execFile(file, args, { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) =>
          resolve(err ? null : stdout),
        );
      });
    },
  };
}

function envGet(env: DetectDeps['env'], name: string, caseInsensitive: boolean): string | undefined {
  if (!caseInsensitive) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Finds an executable on PATH (honours PATHEXT on Windows). */
export async function which(name: string, deps: DetectDeps): Promise<string | null> {
  const win = deps.platform === 'win32';
  const sep = win ? ';' : ':';
  if ((win ? win32 : posix).isAbsolute(name)) return (await deps.isFile(name)) ? name : null;
  const dirs = (envGet(deps.env, 'PATH', win) ?? '').split(sep).filter(Boolean);
  const exts = win
    ? /\.[a-z0-9]+$/i.test(name)
      ? ['']
      : (envGet(deps.env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = dirs.flatMap((dir) =>
    exts.map((ext) =>
      win ? `${dir.replace(/[\\/]+$/, '')}\\${name}${ext.toLowerCase()}` : posix.join(dir, name + ext),
    ),
  );
  // All candidates are checked concurrently (hundreds of sequential stats with a long PATH × PATHEXT on
  // Windows); the first match in PATH order wins.
  const found = await Promise.all(candidates.map((c) => deps.isFile(c)));
  return candidates[found.indexOf(true)] ?? null;
}

export function envValue(deps: DetectDeps, name: string): string | undefined {
  return envGet(deps.env, name, deps.platform === 'win32');
}
