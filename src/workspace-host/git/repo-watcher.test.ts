import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isGitVersionSupported, parseGitVersion } from './exec';
import { ignorePatterns, RepoWatcher, type WatchEvent } from './repo-watcher';

const root = join('/', 'repo');
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

async function setup(opts: { gitDir?: string } = {}) {
  const subs: { dir: string; ignore: string[]; cb: (err: Error | null, e: WatchEvent[]) => void }[] = [];
  const refresh = vi.fn();
  const touched = vi.fn();
  const watcher = new RepoWatcher({
    root,
    gitDir: opts.gitDir ?? join(root, '.git'),
    commonDir: opts.gitDir ?? join(root, '.git'),
    ignoredFolders: ['node_modules'],
    subscribe: (dir, cb, o) => {
      subs.push({ dir, ignore: o.ignore, cb });
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    onRefresh: refresh,
    onTouched: touched,
    logger,
    touchedThrottleMs: 0,
  });
  await watcher.start();
  return { subs, refresh, touched, watcher };
}

describe('RepoWatcher', () => {
  it('watches the tree with ignores and classifies events', async () => {
    vi.useFakeTimers();
    try {
      const s = await setup();
      expect(s.subs).toHaveLength(1);
      expect(s.subs[0]!.ignore).toEqual(expect.arrayContaining(['node_modules', '**/node_modules', '.git/objects']));
      const emit = (...paths: string[]) =>
        s.subs[0]!.cb(
          null,
          paths.map((p) => ({ path: join(root, p), type: 'update' })),
        );

      emit(join('src', 'a.ts'));
      expect(s.refresh).toHaveBeenLastCalledWith('fs');
      await vi.advanceTimersByTimeAsync(1);
      expect(s.touched).toHaveBeenCalledWith(['src/a.ts']);

      s.refresh.mockClear();
      emit(join('.git', 'index.lock'), join('.git', 'COMMIT_EDITMSG'));
      expect(s.refresh).not.toHaveBeenCalled();
      emit(join('.git', 'refs', 'heads', 'main'));
      expect(s.refresh).toHaveBeenLastCalledWith('gitdir');
      emit(join('.git', 'index'));
      expect(s.refresh).toHaveBeenLastCalledWith('gitdir');
      await s.watcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes a git directory outside the project separately', async () => {
    const s = await setup({ gitDir: join('/', 'elsewhere', '.git') });
    expect(s.subs.map((x) => x.dir)).toEqual([root, join('/', 'elsewhere', '.git')]);
    s.subs[1]!.cb(null, [{ path: join('/', 'elsewhere', '.git', 'HEAD'), type: 'update' }]);
    expect(s.refresh).toHaveBeenCalledWith('gitdir');
  });

  it('builds ignore patterns for any depth', () => {
    expect(ignorePatterns(['dist/', 'node_modules'])).toEqual([
      'dist',
      '**/dist',
      '**/dist/**',
      'node_modules',
      '**/node_modules',
      '**/node_modules/**',
    ]);
  });
});

describe('git version', () => {
  it('parses and checks the minimum version', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1')).toEqual([2, 43, 0]);
    expect(parseGitVersion('git version 2.30')).toEqual([2, 30, 0]);
    expect(parseGitVersion('nope')).toBeNull();
    expect(isGitVersionSupported([2, 30, 0])).toBe(true);
    expect(isGitVersionSupported([2, 29, 9])).toBe(false);
    expect(isGitVersionSupported([3, 0, 0])).toBe(true);
  });
});
