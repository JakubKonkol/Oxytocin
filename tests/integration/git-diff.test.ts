import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectEol, getFileDiff, type FileDiffInput } from '../../src/workspace-host/git/file-diff';
import { languageIdFor } from '../../src/workspace-host/git/language';

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'pipe',
  }).toString();

const input = (over: Partial<FileDiffInput>): FileDiffInput => ({
  gitPath: 'git',
  toplevel: dir,
  pathspec: null,
  hasHead: true,
  path: 'a.txt',
  status: 'modified',
  maxBytes: 2 * 1024 * 1024,
  ...over,
});

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'oxy-diff-')));
  git('init', '-q', '-b', 'main');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('getFileDiff', () => {
  it('returns HEAD and disk contents for modified, added and deleted files', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\n');
    await writeFile(join(dir, 'gone.txt'), 'bye\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'a.txt'), '﻿one\ntwo\n');
    await rm(join(dir, 'gone.txt'));
    await writeFile(join(dir, 'new.ts'), 'export {};\n');

    expect(await getFileDiff(input({}))).toMatchObject({
      original: 'one\n',
      modified: 'one\ntwo\n',
      languageId: 'plaintext',
      eol: 'lf',
    });
    expect(await getFileDiff(input({ path: 'gone.txt', status: 'deleted' }))).toMatchObject({
      original: 'bye\n',
      modified: null,
    });
    expect(await getFileDiff(input({ path: 'new.ts', status: 'untracked' }))).toMatchObject({
      original: null,
      modified: 'export {};\n',
      languageId: 'typescript',
    });
  });

  it('applies checkout filters so CRLF files show no false differences', async () => {
    git('config', 'core.autocrlf', 'true');
    await writeFile(join(dir, 'crlf.txt'), 'a\r\nb\r\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'crlf.txt'), 'a\r\nB\r\n');
    const diff = await getFileDiff(input({ path: 'crlf.txt' }));
    expect(diff.original).toBe('a\r\nb\r\n');
    expect(diff.modified).toBe('a\r\nB\r\n');
    expect(diff.eol).toBe('crlf');
  });

  it('reads renamed files from their old path and works in monorepo subfolders', async () => {
    await mkdir(join(dir, 'pkg'));
    await writeFile(join(dir, 'pkg', 'old.md'), '# t\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('mv', 'pkg/old.md', 'pkg/new.md');
    const diff = await getFileDiff(input({ pathspec: 'pkg', path: 'new.md', oldPath: 'old.md', status: 'renamed' }));
    expect(diff).toMatchObject({ original: '# t\n', modified: '# t\n', languageId: 'markdown', oldPath: 'old.md' });
  });

  it('flags binary and too large files without content', async () => {
    await writeFile(join(dir, 'b.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(5000));
    git('add', '.');
    git('commit', '-qm', 'init');
    await writeFile(join(dir, 'b.bin'), Buffer.from([1, 0, 3, 4]));
    expect(await getFileDiff(input({ path: 'b.bin' }))).toMatchObject({
      binary: true,
      original: null,
      modified: null,
      sizes: { original: 3, modified: 4 },
    });
    expect(await getFileDiff(input({ path: 'big.txt', maxBytes: 1000 }))).toMatchObject({
      tooLarge: { sizeBytes: 5000 },
      original: null,
    });
  });

  it('refuses paths outside the repository', async () => {
    await expect(getFileDiff(input({ path: '../escape.txt' }))).rejects.toThrow(/outside/);
  });
});

describe('diff helpers', () => {
  it('detects line endings and languages', () => {
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\r\nb\n')).toBe('mixed');
    expect(detectEol('single')).toBeUndefined();
    expect(languageIdFor('src/App.tsx')).toBe('typescript');
    expect(languageIdFor('Dockerfile.dev')).toBe('dockerfile');
    expect(languageIdFor('.gitignore')).toBe('ini');
    expect(languageIdFor('LICENSE')).toBe('plaintext');
  });
});
