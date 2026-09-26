import { describe, expect, it, vi } from 'vitest';
import { parseMarkedEnv, resolveShellEnv } from './resolve-shell-env';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

describe('parseMarkedEnv', () => {
  it('ignores shell noise around the markers', () => {
    const out = 'Welcome!\n__OXY_ENV_MARK__PATH=/a:/b\0HOME=/h\0X=a=b\0__OXY_ENV_MARK__bye';
    expect(parseMarkedEnv(out)).toEqual({ PATH: '/a:/b', HOME: '/h', X: 'a=b' });
    expect(parseMarkedEnv('no markers')).toBeNull();
  });
});

describe('resolveShellEnv', () => {
  it('returns the process env on Windows and in Linux terminals', async () => {
    const env = { TERM: 'xterm', A: '1' };
    expect(await resolveShellEnv({ platform: 'win32', env, logger })).toBe(env);
    expect(await resolveShellEnv({ platform: 'linux', env, logger })).toBe(env);
  });

  it.skipIf(process.platform === 'win32')('resolves the login shell environment', async () => {
    const env = await resolveShellEnv({
      platform: 'darwin',
      env: { SHELL: '/bin/sh', PATH: process.env['PATH'] ?? '/usr/bin:/bin', MARKER: 'kept' },
      logger,
    });
    expect(env['MARKER']).toBe('kept');
    expect(env['PATH']).toBeTruthy();
  });
});
