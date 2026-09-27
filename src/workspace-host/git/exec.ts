import { spawn } from 'node:child_process';
import { OxyError } from '@shared/errors';

export interface GitExecOptions {
  cwd: string;
  timeoutMs?: number;
  /** Maximum stdout size in bytes (default 50 MB). */
  maxBuffer?: number;
  /** Extra environment (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Arguments every git call starts with. */
export const GIT_BASE_ARGS = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false'];

/**
 * Runs git without taking optional locks (no `index.lock` fights with agents running git), with a timeout and
 * an output limit. Resolves with the exit code; rejects only when git cannot run or limits are exceeded.
 */
export function runGit(gitPath: string, args: readonly string[], opts: GitExecOptions): Promise<GitResult> {
  const maxBuffer = opts.maxBuffer ?? 50 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitPath, [...GIT_BASE_ARGS, ...args], {
        cwd: opts.cwd,
        env: {
          ...process.env,
          ...opts.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new OxyError('GIT_NOT_FOUND', `Could not run git: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new OxyError('TIMEOUT', `git ${args[0] ?? ''} timed out`)));
    }, opts.timeoutMs ?? 30_000);
    const onAbort = () => {
      child.kill();
      finish(() => reject(new OxyError('CANCELLED', 'git call cancelled')));
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        child.kill();
        finish(() => reject(new OxyError('INTERNAL', `git ${args[0] ?? ''} output exceeds ${maxBuffer} bytes`)));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === 'ENOENT'
            ? new OxyError('GIT_NOT_FOUND', `git not found (${gitPath})`)
            : new OxyError('SPAWN_FAILED', `Could not run git: ${e.message}`),
        ),
      ),
    );
    child.on('close', (code) => finish(() => resolve({ stdout: Buffer.concat(out), stderr, code: code ?? -1 })));
  });
}

/** Parses `git version 2.43.0.windows.1` → [2, 43, 0]. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export const MIN_GIT_VERSION: [number, number, number] = [2, 30, 0];

export function isGitVersionSupported(v: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== MIN_GIT_VERSION[i]) return (v[i] ?? 0) > MIN_GIT_VERSION[i]!;
  }
  return true;
}
