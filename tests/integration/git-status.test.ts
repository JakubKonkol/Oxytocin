import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileChange } from '../../src/shared/domain/git';
import { computeStatus } from '../../src/workspace-host/git/compute-status';
import { discoverRepo } from '../../src/workspace-host/git/discover';

let dir: string;
const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: 'pipe' }).toString();

async function status(root: string) {
  const info = await discoverRepo('git', root);
  if (info.state !== 'ok') throw new Error('not a repo');
  return computeStatus({
    projectId: 'p',
    gitPath: 'git',
    toplevel: info.toplevel,
    pathspec: info.pathspec,
    hasHead: info.hasHead,
    maxFiles: 5000,
  });
}
const byPath = (files: FileChange[]) => Object.fromEntries(files.map((f) => [f.path, f]));

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'oxy-status-')));
  git(dir, 'init', '-q', '-b', 'main');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function commitFiles(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

describe('computeStatus', () => {
  it('handles a repository without commits', async () => {
    await writeFile(join(dir, 'new.txt'), 'a\nb\n');
    await writeFile(join(dir, 'staged.txt'), 'x\n');
    git(dir, 'add', 'staged.txt');
    const s = await status(dir);
    expect(s).toMatchObject({ state: 'ok', hasHead: false, branch: { head: 'main' } });
    expect(byPath(s.files)).toMatchObject({
      'new.txt': { status: 'untracked', additions: 2, deletions: 0, staged: false, unstaged: true },
      'staged.txt': { status: 'added', additions: 1, deletions: 0, staged: true, unstaged: false },
    });
    expect(s.headCommit).toBeUndefined();
  });

  it('reports added, modified, deleted, renamed and untracked files with totals', async () => {
    await commitFiles({ 'a.txt': '1\n2\n3\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n', 'e.txt': 'e\ne\n' });
    await writeFile(join(dir, 'a.txt'), '1\nTWO\n3\n4\n');
    await rm(join(dir, 'b.txt'));
    git(dir, 'mv', 'c.txt', 'c2.txt');
    await rename(join(dir, 'd.txt'), join(dir, 'd2.txt')); // plain mv: deleted + untracked
    await writeFile(join(dir, 'f.txt'), 'f\n');
    git(dir, 'add', 'f.txt');
    await writeFile(join(dir, 'u.txt'), 'u1\nu2\nu3');
    const s = await status(dir);
    const files = byPath(s.files);
    expect(files['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 1, unstaged: true });
    expect(files['b.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(files['c2.txt']).toMatchObject({ status: 'renamed', oldPath: 'c.txt', staged: true });
    expect(files['d.txt']).toMatchObject({ status: 'deleted' });
    expect(files['d2.txt']).toMatchObject({ status: 'untracked', additions: 1 });
    expect(files['f.txt']).toMatchObject({ status: 'added', additions: 1 });
    expect(files['u.txt']).toMatchObject({ status: 'untracked', additions: 3 });
    expect(files['e.txt']).toBeUndefined();
    expect(s.totals).toEqual({ files: 7, additions: 2 + 1 + 1 + 3, deletions: 1 + 1 + 1 });
    expect(s.headCommit).toMatchObject({ subject: 'init' });
    expect(s.files.map((f) => f.path)).toEqual([...s.files.map((f) => f.path)].sort());
  });

  it('marks binary files', async () => {
    await commitFiles({ 'img.bin': 'x' });
    await writeFile(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await writeFile(join(dir, 'new.bin'), Buffer.from([0, 0, 0]));
    const files = byPath((await status(dir)).files);
    expect(files['img.bin']).toMatchObject({ status: 'modified', binary: true });
    expect(files['new.bin']).toMatchObject({ status: 'untracked', binary: true });
  });

  it('does not report CRLF-only differences with core.autocrlf=true', async () => {
    git(dir, 'config', 'core.autocrlf', 'true');
    await writeFile(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'crlf');
    await writeFile(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
    expect((await status(dir)).files).toEqual([]);
    await writeFile(join(dir, 'crlf.txt'), 'one\r\nTWO\r\n');
    expect(byPath((await status(dir)).files)['crlf.txt']).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('limits a monorepo project to its folder', async () => {
    await commitFiles({ 'packages/app/a.ts': 'a\n', 'packages/lib/b.ts': 'b\n' });
    await writeFile(join(dir, 'packages', 'app', 'a.ts'), 'A\n');
    await writeFile(join(dir, 'packages', 'lib', 'b.ts'), 'B\n');
    await writeFile(join(dir, 'packages', 'app', 'new.ts'), 'n\n');
    const s = await status(join(dir, 'packages', 'app'));
    expect(s.files.map((f) => f.path)).toEqual(['a.ts', 'new.ts']);
  });

  it('works in a linked worktree', async () => {
    await commitFiles({ 'a.txt': 'a\n' });
    const wt = `${dir}-wt`;
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
    try {
      await writeFile(join(wt, 'a.txt'), 'changed\n');
      const s = await status(wt);
      expect(s.branch?.head).toBe('side');
      expect(s.files.map((f) => f.path)).toEqual(['a.txt']);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  it('truncates long change lists, most recently touched first', async () => {
    await commitFiles({ 'keep.txt': 'k\n' });
    for (let i = 0; i < 120; i++) await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    const info = await discoverRepo('git', dir);
    if (info.state !== 'ok') throw new Error('not a repo');
    const s = await computeStatus({
      projectId: 'p',
      gitPath: 'git',
      toplevel: info.toplevel,
      pathspec: null,
      hasHead: true,
      maxFiles: 100,
      touched: new Map([['f119.txt', Date.now()]]),
    });
    expect(s.truncated).toEqual({ shown: 100, total: 120 });
    expect(s.totals.files).toBe(120);
    expect(s.files.some((f) => f.path === 'f119.txt' && f.touchedAt)).toBe(true);
  });

  it('never blocks concurrent git commands with index.lock', async () => {
    await commitFiles({ 'loop.txt': '0\n' });
    let stop = false;
    let refreshes = 0;
    const refreshLoop = (async () => {
      while (!stop) {
        await status(dir);
        refreshes++;
      }
    })();
    const commit = (i: number) =>
      new Promise<number>((resolve) => {
        const child = spawn('git', [...IDENTITY, 'commit', '-qam', `c${i}`], { cwd: dir, stdio: 'ignore' });
        child.on('close', (code) => resolve(code ?? -1));
      });
    const failures: number[] = [];
    for (let i = 1; i <= 100; i++) {
      await writeFile(join(dir, 'loop.txt'), `${i}\n`);
      const code = await commit(i);
      if (code !== 0) failures.push(i);
    }
    stop = true;
    await refreshLoop;
    expect(failures).toEqual([]);
    expect(refreshes).toBeGreaterThan(5);
  }, 120_000);
});
