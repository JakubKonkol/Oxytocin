import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitAction } from '../../src/shared/domain/git';
import { computeStatus } from '../../src/workspace-host/git/compute-status';
import { checkPaths, listBranches, runGitAction } from '../../src/workspace-host/git/git-actions';

let dir: string;
let remote: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

async function status() {
  return computeStatus({
    projectId: 'p',
    gitPath: 'git',
    toplevel: dir,
    pathspec: null,
    hasHead: true,
    maxFiles: 1000,
  });
}

async function act(action: GitAction) {
  const s = await status();
  return runGitAction(
    { gitPath: 'git', toplevel: dir, pathspec: null, hasHead: s.hasHead, files: s.files, branch: s.branch },
    action,
  );
}

const summary = async () =>
  (await status()).files.map((f) => `${f.status}:${f.path}:${f.staged ? 'S' : ''}${f.unstaged ? 'U' : ''}`);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'oxy-actions-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@e');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await writeFile(join(dir, 'b[1].txt'), 'bracket\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  if (remote) await rm(remote, { recursive: true, force: true });
});

describe('git actions', () => {
  it('stages and unstages paths literally (no glob matching)', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'b1.txt'), 'not the bracket file\n');
    await writeFile(join(dir, 'b[1].txt'), 'changed\n');
    await act({ kind: 'stage', paths: ['b[1].txt'] });
    expect(await summary()).toEqual(['modified:a.txt:U', 'untracked:b1.txt:U', 'modified:b[1].txt:S']);
    await act({ kind: 'stageAll' });
    expect((await summary()).every((s) => s.endsWith(':S'))).toBe(true);
    await act({ kind: 'unstage', paths: ['a.txt'] });
    expect(await summary()).toContain('modified:a.txt:U');
    await act({ kind: 'unstageAll' });
    expect(await summary()).toEqual(['modified:a.txt:U', 'untracked:b1.txt:U', 'modified:b[1].txt:U']);
  });

  it('discards modified, new and staged files back to HEAD', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'new.txt'), 'new\n');
    await writeFile(join(dir, 'staged-new.txt'), 'staged\n');
    git(dir, 'add', 'staged-new.txt');
    await rm(join(dir, 'b[1].txt'));
    await act({ kind: 'discard', paths: ['a.txt', 'new.txt', 'staged-new.txt', 'b[1].txt'] });
    expect(await summary()).toEqual([]);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    await expect(stat(join(dir, 'new.txt'))).rejects.toThrow();
    await expect(stat(join(dir, 'staged-new.txt'))).rejects.toThrow();
    expect(await readFile(join(dir, 'b[1].txt'), 'utf8')).toBe('bracket\n');

    await writeFile(join(dir, 'a.txt'), 'three\n');
    await writeFile(join(dir, 'x.txt'), 'x\n');
    git(dir, 'add', 'x.txt');
    await writeFile(join(dir, 'y.txt'), 'y\n');
    await act({ kind: 'discardAll' });
    expect(await summary()).toEqual([]);
  });

  it('commits staged changes or everything, amends and undoes the last commit', async () => {
    await writeFile(join(dir, 'a.txt'), 'two\n');
    await writeFile(join(dir, 'c.txt'), 'c\n');
    await act({ kind: 'stage', paths: ['a.txt'] });
    const first = await act({ kind: 'commit', message: 'feat: a' });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('feat: a');
    expect(await summary()).toEqual(['untracked:c.txt:U']);

    await act({ kind: 'commit', message: 'feat: all', stageAll: true });
    expect(await summary()).toEqual([]);
    await act({ kind: 'commit', message: 'feat: renamed', amend: true });
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual(['feat: renamed', 'feat: a', 'init']);

    await act({ kind: 'undoCommit' });
    expect(await summary()).toEqual(['added:c.txt:S']);
    await expect(act({ kind: 'commit', message: '  ' })).rejects.toThrow(/commit message/);
  });

  it('creates and switches branches, stashes and pops', async () => {
    await act({ kind: 'createBranch', name: 'feature/x' });
    expect(git(dir, 'branch', '--show-current').trim()).toBe('feature/x');
    await expect(act({ kind: 'createBranch', name: 'bad name..' })).rejects.toThrow(/not a valid branch name/);
    await act({ kind: 'checkout', branch: 'main' });
    const branches = await listBranches({ gitPath: 'git', toplevel: dir });
    expect(branches.current).toBe('main');
    expect(branches.local.map((b) => b.name).sort()).toEqual(['feature/x', 'main']);

    await writeFile(join(dir, 'a.txt'), 'stashed\n');
    await writeFile(join(dir, 'u.txt'), 'untracked\n');
    await act({ kind: 'stash', message: 'wip' });
    expect(await summary()).toEqual([]);
    expect((await listBranches({ gitPath: 'git', toplevel: dir })).stashes).toBe(1);
    await act({ kind: 'stashPop' });
    expect(await summary()).toEqual(['modified:a.txt:U', 'untracked:u.txt:U']);
  });

  it('publishes a branch to the remote and pulls from it', async () => {
    remote = await realpath(await mkdtemp(join(tmpdir(), 'oxy-remote-')));
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', remote);
    await act({ kind: 'push' });
    expect((await status()).branch?.upstream).toBe('origin/main');
    await writeFile(join(dir, 'a.txt'), 'pushed\n');
    await act({ kind: 'commit', message: 'second', stageAll: true });
    expect((await status()).branch?.ahead).toBe(1);
    await act({ kind: 'push' });
    expect((await status()).branch?.ahead).toBe(0);
    await act({ kind: 'fetch' });
    await act({ kind: 'pull' });
  });

  it('refuses paths that leave the project', () => {
    expect(() => checkPaths(['../x'])).toThrow(/Invalid path/);
    expect(() => checkPaths(['/etc/passwd'])).toThrow(/Invalid path/);
    expect(() => checkPaths(['C:/x'])).toThrow(/Invalid path/);
    expect(() => checkPaths(['src/a.ts'])).not.toThrow();
  });

  it('discards everything in a project folder that has no commit yet', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'pkg'));
    await writeFile(join(dir, 'pkg', 'new.txt'), 'new\n');
    const s = await computeStatus({
      projectId: 'p',
      gitPath: 'git',
      toplevel: dir,
      pathspec: 'pkg',
      hasHead: true,
      maxFiles: 100,
    });
    expect(s.files.map((f) => f.path)).toEqual(['new.txt']);
    await runGitAction(
      { gitPath: 'git', toplevel: dir, pathspec: 'pkg', hasHead: true, files: s.files, branch: s.branch },
      { kind: 'discardAll' },
    );
    await expect(stat(join(dir, 'pkg', 'new.txt'))).rejects.toThrow();
  });
});
