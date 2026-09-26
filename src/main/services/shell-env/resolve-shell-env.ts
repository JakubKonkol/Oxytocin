import { spawn } from 'node:child_process';
import type { Logger } from '@shared/logging/logger';

const MARK = '__OXY_ENV_MARK__';

/** Parses `env -0` output wrapped in markers (anything the shell prints around it is ignored). */
export function parseMarkedEnv(output: string): Record<string, string> | null {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start < 0 || end <= start) return null;
  const body = output.slice(start + MARK.length, end);
  const env: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
}

/**
 * GUI apps on macOS (and Linux desktop launchers) do not inherit PATH from the user's shell profile.
 * Resolve the environment of an interactive login shell, falling back to `process.env` after `timeoutMs`.
 */
export function resolveShellEnv(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  timeoutMs?: number;
}): Promise<NodeJS.ProcessEnv> {
  const { platform, env, logger } = opts;
  if (platform === 'win32') return Promise.resolve(env);
  // Started from a terminal (Linux) — the environment is already complete.
  if (platform === 'linux' && env['TERM']) return Promise.resolve(env);
  const shell = env['SHELL'] || '/bin/sh';
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (result: NodeJS.ProcessEnv, reason?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (reason) logger.warn(`Could not resolve the shell environment (${reason}); using the process environment`);
      resolve(result);
    };
    const child = spawn(shell, ['-l', '-i', '-c', `printf '${MARK}'; command env -0; printf '${MARK}'`], {
      env: { ...env, OXYTOCIN_RESOLVING_ENVIRONMENT: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(env, 'timeout');
    }, opts.timeoutMs ?? 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.on('error', (e) => finish(env, e.message));
    child.on('close', () => {
      const parsed = parseMarkedEnv(out);
      if (!parsed) {
        finish(env, 'no output');
        return;
      }
      delete parsed['OXYTOCIN_RESOLVING_ENVIRONMENT'];
      delete parsed['SHLVL'];
      finish({ ...env, ...parsed });
    });
  });
}
