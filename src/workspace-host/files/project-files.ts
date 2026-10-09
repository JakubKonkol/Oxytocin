import type { Dirent } from 'node:fs';
import { mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FileContent, FileEntry, FileList, FileStat } from '@shared/domain/files';
import { OxyError } from '@shared/errors';
import { languageIdFor } from '@shared/utils/language';
import { runGit } from '../git/exec';
import { detectEol } from '../git/file-diff';

/**
 * Files of a project for the built-in code editor and the FILES section: listing, finding, reading and writing.
 * Every path is project-relative and must stay inside the project folder.
 */

/** Absolute path of a project-relative path; rejects anything that leaves the root. */
export function resolveInside(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\\')) throw new OxyError('PERMISSION', 'Path outside the project');
  const parts = path === '' ? [] : path.split('/');
  if (parts.some((p) => p === '..' || p === '')) throw new OxyError('PERMISSION', 'Path outside the project');
  const absolute = resolve(root, ...parts);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new OxyError('PERMISSION', 'Path outside the project');
  return absolute;
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

/** Names git ignores among `names` (inside `dir`); empty outside a repository. */
async function ignoredNames(gitPath: string, dir: string, names: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < names.length; i += 200) {
    const chunk = names.slice(i, i + 200);
    const r = await runGit(gitPath, ['check-ignore', '--', ...chunk], { cwd: dir, timeoutMs: 10_000 }).catch(
      () => null,
    );
    // 0: some ignored, 1: none, 128: not a repository.
    if (!r || r.code > 1) return out;
    for (const line of r.stdout.toString('utf8').split('\n')) {
      // Unusual names come back C-quoted ("a\"b"); JSON reads the common escapes.
      const name = line.startsWith('"') ? safeUnquote(line) : line;
      if (name) out.add(name);
    }
  }
  return out;
}

function safeUnquote(quoted: string): string {
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return '';
  }
}

/** The entries of a folder: folders first, then files, by name; `.git` is hidden. */
export async function listDir(o: { root: string; path: string; gitPath: string }): Promise<FileEntry[]> {
  const dir = resolveInside(o.root, o.path);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw new OxyError('NOT_FOUND', `Cannot read the folder: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    if (e.isDirectory()) out.push({ name: e.name, kind: 'dir' });
    else if (e.isFile()) out.push({ name: e.name, kind: 'file' });
    else if (e.isSymbolicLink()) {
      const target = await stat(join(dir, e.name)).catch(() => null);
      if (target) out.push({ name: e.name, kind: target.isDirectory() ? 'dir' : 'file', symlink: true });
    }
  }
  const ignored = await ignoredNames(
    o.gitPath,
    dir,
    out.map((e) => e.name),
  );
  for (const e of out) if (ignored.has(e.name)) e.ignored = true;
  return out.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
}

/**
 * Every file of the project for Quick Open: tracked and untracked files git does not ignore, or (outside a
 * repository) a walk that skips the ignored folders. Paths are sorted and project-relative.
 */
export async function findFiles(o: {
  root: string;
  gitPath: string;
  ignoredFolders: readonly string[];
  limit: number;
}): Promise<FileList> {
  const r = await runGit(o.gitPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: o.root,
    timeoutMs: 30_000,
    maxBuffer: 200 * 1024 * 1024,
  }).catch(() => null);
  if (r && r.code === 0) {
    const all = [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))].sort();
    return { files: all.slice(0, o.limit), truncated: all.length > o.limit };
  }
  const skip = new Set(['.git', ...o.ignoredFolders]);
  const files: string[] = [];
  const queue = [''];
  let truncated = false;
  while (queue.length > 0) {
    const rel = queue.shift()!;
    const entries = await readdir(rel ? join(o.root, ...rel.split('/')) : o.root, { withFileTypes: true }).catch(
      () => [] as Dirent[],
    );
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) queue.push(path);
      } else if (e.isFile()) {
        if (files.length >= o.limit) {
          truncated = true;
          break;
        }
        files.push(path);
      }
    }
    if (truncated) break;
  }
  return { files: files.sort(), truncated };
}

export async function statFile(o: { root: string; path: string }): Promise<FileStat | null> {
  try {
    const s = await stat(resolveInside(o.root, o.path));
    return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() };
  } catch (e) {
    if (e instanceof OxyError) throw e;
    return null;
  }
}

/** A file's text (UTF-8, BOM removed and reported), or why it cannot be edited (binary, too large). */
export async function readFileContent(o: { root: string; path: string; maxBytes: number }): Promise<FileContent> {
  const absolute = resolveInside(o.root, o.path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new OxyError('NOT_FOUND', `File not found: ${o.path}`);
  }
  if (!info.isFile()) throw new OxyError('INVALID', `Not a file: ${o.path}`);
  const base = { path: o.path, languageId: languageIdFor(o.path), size: info.size, mtimeMs: info.mtimeMs };
  if (info.size > o.maxBytes) return { ...base, content: null, tooLarge: true };
  const handle = await open(absolute, 'r');
  let data: Buffer;
  try {
    data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, info.size, 0);
    data = data.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (isBinary(data)) return { ...base, content: null, binary: true };
  let text = data.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = detectEol(text);
  return { ...base, content: text, ...(bom ? { bom } : {}), ...(eol ? { eol } : {}) };
}

/**
 * Saves a file. With `expectedMtimeMs` the save is refused (CONFLICT) when the file changed on disk after it was
 * read, so an agent's edit is never overwritten without asking.
 */
export async function writeFileContent(o: {
  root: string;
  path: string;
  content: string;
  bom?: boolean | undefined;
  expectedMtimeMs?: number | undefined;
}): Promise<FileStat> {
  const absolute = resolveInside(o.root, o.path);
  if (o.expectedMtimeMs !== undefined) {
    const current = await stat(absolute).catch(() => null);
    if (current && Math.abs(current.mtimeMs - o.expectedMtimeMs) > 1)
      throw new OxyError('CONFLICT', `${o.path} changed on disk since it was opened.`);
  }
  await writeFile(absolute, o.bom ? `\uFEFF${o.content}` : o.content);
  const s = await stat(absolute);
  return { mtimeMs: s.mtimeMs, size: s.size, isFile: true };
}

/** A new empty file or folder (its parent folders are created); fails when the path exists. */
export async function createEntry(o: { root: string; path: string; kind: 'file' | 'dir' }): Promise<void> {
  const absolute = resolveInside(o.root, o.path);
  if (await stat(absolute).catch(() => null)) throw new OxyError('INVALID', `${o.path} already exists.`);
  if (o.kind === 'dir') await mkdir(absolute, { recursive: true });
  else {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, '', { flag: 'wx' });
  }
}

/** Renames or moves a file or folder inside the project; fails when the target exists. */
export async function renameEntry(o: { root: string; from: string; to: string }): Promise<void> {
  const from = resolveInside(o.root, o.from);
  const to = resolveInside(o.root, o.to);
  if (from === o.root) throw new OxyError('INVALID', 'The project folder cannot be renamed here.');
  const sameEntry = from.toLowerCase() === to.toLowerCase() && from !== to;
  if (!sameEntry && (await stat(to).catch(() => null))) throw new OxyError('INVALID', `${o.to} already exists.`);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}
