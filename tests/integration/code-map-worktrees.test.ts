import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { CodeMapCheckouts } from '../../src/code-map-host/checkouts';
import { fileRecord } from '../../src/code-map-host/extract/files';
import { copyCodeMapAssets } from '../../scripts/code-map-assets';
import { changes, commitAll } from '../../src/workspace-host/git/ensemble-git';

it('keeps divergent worktree maps and Git ignores separate, and excludes tracked .oxy data from task commits', async () => {
  const base = await mkdtemp(join(tmpdir(), 'oxy-map-worktrees-')),
    repo = join(base, 'repo'),
    assets = join(base, 'assets');
  await mkdir(repo);
  const git = async (cwd: string, ...args: string[]) =>
    (await promisify(execFile)('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true })).stdout;
  const checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
    assets,
    parserEntry: '',
    parser: {
      parse: (path, source) => Promise.resolve(fileRecord(path, source)),
      dispose: () => Promise.resolve(),
    },
  });
  try {
    await copyCodeMapAssets(assets);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.invalid');
    await mkdir(join(repo, '.oxy'));
    await writeFile(join(repo, '.oxy/tracked-map.json'), 'base map');
    await writeFile(join(repo, 'api.ts'), 'base');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'fixture');
    const trees = ['one', 'two'].map((name) => join(base, name));
    for (const [i, root] of trees.entries()) {
      await git(repo, 'worktree', 'add', '--detach', root, 'HEAD');
      await writeFile(join(root, 'api.ts'), `tree ${i}`);
      await checkouts.configure({
        checkoutId: `tree${i}`,
        projectId: 'p',
        root,
        mode: 'worktree',
        gitPath: 'git',
        ignoreInGit: false,
      });
    }
    await vi.waitFor(() => expect(trees.map((_, i) => checkouts.status(`tree${i}`).state)).toEqual(['ready', 'ready']));
    for (const [i, root] of trees.entries()) {
      const result = await checkouts.query(`tree${i}`, `q${i}`, { kind: 'outline', path: 'api.ts' });
      expect(result.data).toMatchObject({ kind: 'outline', file: { bytes: `tree ${i}`.length } });
      expect(await readFile(join(root, '.oxy/.gitignore'), 'utf8')).toBe('*\n');
      await expect(readFile(join(root, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(trees[0]!, '.oxy/code-map/graph.json'), 'utf8')).not.toBe(
      await readFile(join(trees[1]!, '.oxy/code-map/graph.json'), 'utf8'),
    );
    await checkouts.remove('tree0');
    await expect(checkouts.query('tree0', 'removed', { kind: 'status' })).rejects.toThrow('Unknown');
    const root = trees[0]!;
    await writeFile(join(root, '.oxy/tracked-map.json'), 'updated local map');
    await git(root, 'add', '.oxy/tracked-map.json');
    const taskChanges = await changes({ gitPath: 'git', cwd: root, base: 'HEAD' });
    expect(taskChanges.map((change) => change.path)).toEqual(['api.ts']);
    const checkpoint = await commitAll({ gitPath: 'git', cwd: root, message: 'checkpoint' });
    expect(checkpoint.files).toBe(1);
    expect(await git(root, 'show', 'HEAD:.oxy/tracked-map.json')).toBe('base map');
    expect((await git(root, 'show', '--pretty=', '--name-only', 'HEAD')).trim()).toBe('api.ts');
    await expect(readFile(join(repo, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await checkouts.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

it('excludes .oxy data anywhere in the worktree from checkpoints of a project in a subfolder', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'oxy-map-subfolder-'));
  const git = async (...args: string[]) =>
    (await promisify(execFile)('git', ['--no-optional-locks', ...args], { cwd: repo, windowsHide: true })).stdout;
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.invalid');
    for (const dir of ['.oxy', 'app/.oxy', 'other/.oxy']) await mkdir(join(repo, dir), { recursive: true });
    await writeFile(join(repo, 'app/api.ts'), 'base');
    await git('add', '-A');
    await git('commit', '-qm', 'fixture', '--allow-empty');
    await writeFile(join(repo, 'app/api.ts'), 'changed');
    for (const dir of ['.oxy', 'app/.oxy', 'other/.oxy']) await writeFile(join(repo, dir, 'map.json'), 'map');
    const checkpoint = await commitAll({ gitPath: 'git', cwd: join(repo, 'app'), message: 'checkpoint' });
    expect(checkpoint.files).toBe(1);
    expect((await git('show', '--pretty=', '--name-only', 'HEAD')).trim()).toBe('app/api.ts');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
