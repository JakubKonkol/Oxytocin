import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import watcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoInfo, RepoStatus } from '../../src/shared/domain/git';
import { discoverRepo } from '../../src/workspace-host/git/discover';
import { RepoRegistry } from '../../src/workspace-host/git/repo-registry';
import type { RefreshReason } from '../../src/workspace-host/git/refresh-scheduler';
import { silentLogger } from '../helpers/logger';

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'pipe',
  }).toString();

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'oxy-git-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('repository discovery', () => {
  it('reports non-repositories, repositories without commits and monorepo subfolders', async () => {
    expect(await discoverRepo('git', dir)).toEqual({ state: 'not-a-repo' });
    git(dir, 'init', '-q');
    const fresh = await discoverRepo('git', dir);
    expect(fresh).toMatchObject({ state: 'ok', toplevel: dir, hasHead: false, pathspec: null, isBare: false });
    await mkdir(join(dir, 'packages', 'app'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    expect(await discoverRepo('git', join(dir, 'packages', 'app'))).toMatchObject({
      state: 'ok',
      toplevel: dir,
      hasHead: true,
      pathspec: 'packages/app',
    });
  });
});

describe('RepoRegistry with a real watcher', () => {
  it('requests a refresh within 300 ms of a file write and reacts to commits', async () => {
    git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    await mkdir(join(dir, 'node_modules'));

    const refreshes: { at: number; reasons: RefreshReason[] }[] = [];
    const touched: { at: number; paths: string[] }[] = [];
    const repos: RepoInfo[] = [];
    const registry = new RepoRegistry({
      subscribe: (d, cb, o) => watcher.subscribe(d, cb, o),
      emitRepo: (info) => repos.push(info),
      emitTouched: (e) => touched.push({ at: Date.now(), paths: e.paths }),
      onRefresh: (_entry, reasons) => {
        refreshes.push({ at: Date.now(), reasons: [...reasons] });
        return Promise.resolve();
      },
      logger: silentLogger,
    });
    try {
      await registry.watch({
        projectId: 'p',
        rootPath: dir,
        gitPath: 'git',
        ignoredFolders: ['node_modules'],
        maxFiles: 5000,
      });
      await expect.poll(() => refreshes.length).toBe(1);
      expect(repos.at(-1)).toMatchObject({ state: 'ok', hasHead: true });
      // Let the native subscription settle.
      await new Promise((r) => setTimeout(r, 300));

      const writtenAt = Date.now();
      await writeFile(join(dir, 'b.txt'), 'b');
      await expect.poll(() => touched.flatMap((t) => t.paths), { interval: 10 }).toContain('b.txt');
      const touchedAt = touched.find((t) => t.paths.includes('b.txt'))!.at;
      expect(touchedAt - writtenAt).toBeLessThan(300);
      await expect.poll(() => refreshes.length, { interval: 10 }).toBe(2);
      expect(refreshes[1]!.reasons).toEqual(['fs']);
      // The refresh request itself happens right away; the debounced run follows ≤ 250 ms later.
      expect(refreshes[1]!.at - writtenAt).toBeLessThan(300 + 250);

      // Ignored folders never trigger refreshes.
      await new Promise((r) => setTimeout(r, 400));
      const before = refreshes.length;
      await writeFile(join(dir, 'node_modules', 'x.js'), 'x');
      await new Promise((r) => setTimeout(r, 600));
      expect(refreshes.length).toBe(before);

      git(dir, 'add', 'b.txt');
      git(dir, 'commit', '-qm', 'b');
      await expect.poll(() => refreshes.at(-1)?.reasons.includes('gitdir')).toBe(true);
    } finally {
      await registry.dispose();
    }
  });
});

describe('RepoRegistry status emission', () => {
  it('emits a new status after a write and only when it changed', async () => {
    git(dir, 'init', '-q');
    await writeFile(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const statuses: RepoStatus[] = [];
    const registry = new RepoRegistry({
      subscribe: (d, cb, o) => watcher.subscribe(d, cb, o),
      emitRepo: () => undefined,
      emitTouched: () => undefined,
      emitStatus: (s) => statuses.push(s),
      logger: silentLogger,
    });
    try {
      await registry.watch({ projectId: 'p', rootPath: dir, gitPath: 'git', ignoredFolders: [], maxFiles: 5000 });
      await expect.poll(() => statuses.length).toBe(1);
      expect(statuses[0]).toMatchObject({ state: 'ok', files: [] });
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(join(dir, 'a.txt'), 'a\nb\n');
      await expect.poll(() => statuses.at(-1)?.files.map((f) => `${f.status}:${f.path}`)).toEqual(['modified:a.txt']);
      const count = statuses.length;
      registry.request('p', 'manual');
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses.length).toBe(count);
      expect(registry.get('p')?.status?.files[0]?.touchedAt).toBeGreaterThan(0);
    } finally {
      await registry.dispose();
    }
  });
});
