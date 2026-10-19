import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { enumerate, MAX_SOURCE_BYTES, resolveSourcePath } from './enumerate';
import { fingerprint } from './fingerprint';

const roots: string[] = [];
async function temporary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-enumerate-')));
  roots.push(root);
  return root;
}
async function file(root: string, path: string, value: string | Buffer) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}
async function git(root: string, ...args: string[]) {
  return promisify(execFile)('git', ['--no-optional-locks', ...args], { cwd: root, windowsHide: true });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Code Map enumeration', () => {
  it('includes tracked and untracked files, respects Git and treats nested repositories as boundaries', async () => {
    const root = await temporary();
    await git(root, 'init');
    await file(root, '.gitignore', 'ignored.txt\n');
    await file(root, 'tracked.ts', 'export const tracked = 1;');
    await git(root, 'add', '.');
    await file(root, 'untracked.ts', 'export const untracked = 1;');
    await file(root, 'ignored.txt', 'ignored');
    await file(root, 'nested/source.ts', 'nested');
    await git(join(root, 'nested'), 'init');
    const result = await enumerate({ root, gitPath: 'git' });
    expect(result.files.map((entry) => entry.path)).toEqual(['.gitignore', 'tracked.ts', 'untracked.ts']);
    expect(result.diagnostics.skipped).toContainEqual({ path: 'nested', reason: 'nested-repository' });
  });
  it('applies nested ignore overrides without Git and excludes secrets before probing content', async () => {
    const root = await temporary();
    for (const [path, content] of Object.entries({
      '.gitignore': '*.log\n',
      'src/.gitignore': '!important.log\n',
      'src/important.log': 'included',
      'src/other.log': 'ignored',
      '.env.local': 'DO_NOT_READ',
      'private.pem': 'DO_NOT_READ',
      id_rsa_backup: 'DO_NOT_READ',
      'package-lock.json': '{}',
      '.oxy/code-map/MAP.md': 'generated',
      'src/.oxy/cache': 'generated',
      'node_modules/dep/index.js': 'dependency',
      'src/source.ts': 'source',
      'src/generated/a.ts': 'generated',
    }))
      await file(root, path, content);
    await file(root, 'binary.dat', Buffer.from([1, 0, 2]));
    await file(root, 'huge.ts', Buffer.alloc(MAX_SOURCE_BYTES + 1, 65));
    const result = await enumerate({ root, gitPath: 'git', excludedPaths: ['src/generated/**'] });
    expect(result.files.map((entry) => entry.path)).toEqual([
      '.gitignore',
      'src/.gitignore',
      'src/important.log',
      'src/source.ts',
    ]);
    expect(result.diagnostics.skipped).toEqual(
      expect.arrayContaining([
        { path: '.env.local', reason: 'probable-secret' },
        { path: 'binary.dat', reason: 'binary' },
        { path: 'huge.ts', reason: 'too-large' },
      ]),
    );
    await expect(resolveSourcePath(root, '.env.local')).rejects.toThrow('Excluded');
    await expect(fingerprint(root, '.env.local')).rejects.toThrow('Excluded');
    await expect(fingerprint(root, 'huge.ts')).rejects.toThrow('limit');
  });
  it('does not widen a subproject into its parent repository and enforces file limits', async () => {
    const root = await temporary();
    await git(root, 'init');
    await file(root, 'outside.ts', 'outside');
    await file(root, 'package/inside.ts', 'inside');
    const result = await enumerate({ root: join(root, 'package'), gitPath: 'git' });
    expect(result.files.map((entry) => entry.path)).toEqual(['inside.ts']);
    await file(root, 'package/second.ts', 'second');
    await expect(enumerate({ root: join(root, 'package'), gitPath: 'git', maxFiles: 1 })).rejects.toThrow(
      'limit reached',
    );
  });
  it('refuses source junctions leaving the project', async () => {
    const root = await temporary(),
      outside = await temporary();
    await file(outside, 'outside.ts', 'private');
    await symlink(outside, join(root, 'linked'), 'junction');
    const result = await enumerate({ root, gitPath: 'git' });
    expect(result.files).toEqual([]);
    expect(result.diagnostics.failed[0]?.reason).toContain('escaping');
  });
  it('fingerprints actual content and metadata without retaining absolute paths in the result', async () => {
    const root = await temporary();
    await file(root, 'a.ts', 'one');
    const first = await fingerprint(root, 'a.ts');
    await file(root, 'a.ts', 'two');
    const next = await fingerprint(root, 'a.ts');
    expect(first.fingerprint.sha256).not.toBe(next.fingerprint.sha256);
    expect(next.source).toBe('two');
    expect(JSON.stringify(next.fingerprint)).not.toContain(root);
  });
});
