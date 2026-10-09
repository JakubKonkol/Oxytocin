import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEntry,
  findFiles,
  listDir,
  readFileContent,
  renameEntry,
  resolveInside,
  statFile,
  writeFileContent,
} from '../../src/workspace-host/files/project-files';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-files-')));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# r\n');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n*.log\n');
  await writeFile(join(root, 'debug.log'), 'x');
  await writeFile(join(root, 'node_modules', 'x', 'i.js'), '');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('project files', () => {
  it('lists folders first and marks what git ignores', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const entries = await listDir({ root, path: '', gitPath: 'git' });
    expect(entries.map((e) => `${e.kind}:${e.name}${e.ignored ? ':ignored' : ''}`)).toEqual([
      'dir:node_modules:ignored',
      'dir:src',
      'file:.gitignore',
      'file:debug.log:ignored',
      'file:README.md',
    ]);
    expect(await listDir({ root, path: 'src', gitPath: 'git' })).toEqual([{ name: 'a.ts', kind: 'file' }]);
  });

  it('finds files with git (respecting .gitignore) or by walking the folder', async () => {
    const walked = await findFiles({ root, gitPath: 'git', ignoredFolders: ['node_modules'], limit: 100 });
    expect(walked.files).toEqual(['.gitignore', 'README.md', 'debug.log', 'src/a.ts']);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const found = await findFiles({ root, gitPath: 'git', ignoredFolders: [], limit: 100 });
    expect(found).toEqual({ files: ['.gitignore', 'README.md', 'src/a.ts'], truncated: false });
    expect((await findFiles({ root, gitPath: 'git', ignoredFolders: [], limit: 2 })).truncated).toBe(true);
  });

  it('reads text with its BOM and line endings, refuses binaries and large files', async () => {
    await writeFile(join(root, 'bom.txt'), '\uFEFFa\r\nb\r\n');
    expect(await readFileContent({ root, path: 'bom.txt', maxBytes: 1000 })).toMatchObject({
      content: 'a\r\nb\r\n',
      bom: true,
      eol: 'crlf',
      languageId: 'plaintext',
    });
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(await readFileContent({ root, path: 'bin.dat', maxBytes: 1000 })).toMatchObject({
      content: null,
      binary: true,
    });
    expect(await readFileContent({ root, path: 'src/a.ts', maxBytes: 5 })).toMatchObject({
      content: null,
      tooLarge: true,
    });
    await expect(readFileContent({ root, path: 'missing.ts', maxBytes: 5 })).rejects.toThrow(/not found/);
  });

  it('saves, and refuses to overwrite a file that changed on disk since it was read', async () => {
    const read = await readFileContent({ root, path: 'src/a.ts', maxBytes: 1000 });
    const saved = await writeFileContent({ root, path: 'src/a.ts', content: 'mine\n', expectedMtimeMs: read.mtimeMs });
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('mine\n');
    // An agent writes the file meanwhile.
    await writeFile(join(root, 'src', 'a.ts'), 'agent\n');
    await utimes(join(root, 'src', 'a.ts'), new Date(), new Date(saved.mtimeMs + 5000));
    await expect(
      writeFileContent({ root, path: 'src/a.ts', content: 'again\n', expectedMtimeMs: saved.mtimeMs }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await writeFileContent({ root, path: 'src/a.ts', content: 'forced\n', bom: true });
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('\uFEFFforced\n');
  });

  it('creates, renames and stats entries inside the project only', async () => {
    await createEntry({ root, path: 'lib/new/b.ts', kind: 'file' });
    expect(await statFile({ root, path: 'lib/new/b.ts' })).toMatchObject({ isFile: true, size: 0 });
    await expect(createEntry({ root, path: 'lib/new/b.ts', kind: 'file' })).rejects.toThrow(/already exists/);
    await createEntry({ root, path: 'docs', kind: 'dir' });
    await renameEntry({ root, from: 'lib/new/b.ts', to: 'docs/c.ts' });
    expect(await statFile({ root, path: 'docs/c.ts' })).toMatchObject({ isFile: true });
    expect(await statFile({ root, path: 'lib/new/b.ts' })).toBeNull();
    await expect(renameEntry({ root, from: 'docs/c.ts', to: 'README.md' })).rejects.toThrow(/already exists/);
    expect(() => resolveInside(root, '../outside.txt')).toThrow(/outside the project/);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/outside the project/);
    expect(resolveInside(root, '')).toBe(root);
  });
});
