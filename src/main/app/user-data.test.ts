import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUserDataOverride } from './user-data';

describe('resolveUserDataOverride', () => {
  it('prefers the CLI flag over the environment variable', () => {
    const dir = resolve('/tmp/a');
    expect(resolveUserDataOverride(['app', `--user-data-dir=${dir}`], { OXYTOCIN_USER_DATA_DIR: '/tmp/b' })).toBe(dir);
  });

  it('supports the space-separated form', () => {
    expect(resolveUserDataOverride(['--user-data-dir', resolve('/x')], {})).toBe(resolve('/x'));
  });

  it('falls back to OXYTOCIN_USER_DATA_DIR and resolves relative paths', () => {
    expect(resolveUserDataOverride([], { OXYTOCIN_USER_DATA_DIR: 'rel' })).toBe(resolve('rel'));
  });

  it('returns null without an override', () => {
    expect(resolveUserDataOverride(['app'], {})).toBeNull();
  });
});
