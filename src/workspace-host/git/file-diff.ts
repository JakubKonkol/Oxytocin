import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { ChangeStatus, FileDiffContent } from '@shared/domain/git';
import { OxyError } from '@shared/errors';
import { runGit } from './exec';
import { languageIdFor } from './language';

export interface FileDiffInput {
  gitPath: string;
  toplevel: string;
  pathspec: string | null;
  hasHead: boolean;
  /** Project-relative paths. */
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  maxBytes: number;
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

function decode(buf: Buffer): string {
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function detectEol(text: string): FileDiffContent['eol'] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return undefined;
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

async function readDisk(absolute: string, maxBytes: number): Promise<{ size: number; data: Buffer | null } | null> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    if (info.size > maxBytes) return { size: info.size, data: null };
    const handle = await open(absolute, 'r');
    try {
      const data = Buffer.alloc(info.size);
      await handle.read(data, 0, info.size, 0);
      return { size: info.size, data };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readHead(input: FileDiffInput, topPath: string): Promise<{ size: number; data: Buffer | null } | null> {
  const spec = `HEAD:${topPath}`;
  const size = await runGit(input.gitPath, ['cat-file', '-s', spec], { cwd: input.toplevel, timeoutMs: 10_000 });
  if (size.code !== 0) return null;
  const bytes = Number(size.stdout.toString('utf8').trim());
  if (bytes > input.maxBytes) return { size: bytes, data: null };
  // --filters applies checkout filters (autocrlf, .gitattributes eol, smudge): no false CRLF differences.
  const r = await runGit(input.gitPath, ['cat-file', '--filters', spec], {
    cwd: input.toplevel,
    timeoutMs: 10_000,
    maxBuffer: Math.max(input.maxBytes * 2, 1024 * 1024),
  });
  return r.code === 0 ? { size: r.stdout.length, data: r.stdout } : null;
}

/** HEAD and working-tree contents of one changed file. */
export async function getFileDiff(input: FileDiffInput): Promise<FileDiffContent> {
  const top = (p: string) => (input.pathspec ? `${input.pathspec}/${p}` : p);
  const absolute = join(input.toplevel, ...top(input.path).split('/'));
  const rel = relative(input.toplevel, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new OxyError('PERMISSION', 'Path outside the repository');

  const hasOriginal = input.hasHead && input.status !== 'added' && input.status !== 'untracked';
  const hasModified = input.status !== 'deleted';
  const [head, disk] = await Promise.all([
    hasOriginal ? readHead(input, top(input.oldPath ?? input.path)) : Promise.resolve(null),
    hasModified ? readDisk(absolute, input.maxBytes) : Promise.resolve(null),
  ]);
  const base: FileDiffContent = {
    path: input.path,
    ...(input.oldPath ? { oldPath: input.oldPath } : {}),
    status: input.status,
    original: null,
    modified: null,
    languageId: languageIdFor(input.path),
  };
  const sizes = { original: head?.size ?? null, modified: disk?.size ?? null };
  if ((head && head.data === null) || (disk && disk.data === null)) {
    return { ...base, tooLarge: { sizeBytes: Math.max(head?.size ?? 0, disk?.size ?? 0) }, sizes };
  }
  if ((head?.data && isBinary(head.data)) || (disk?.data && isBinary(disk.data))) {
    return { ...base, binary: true, sizes };
  }
  const original = head?.data ? decode(head.data) : null;
  const modified = disk?.data ? decode(disk.data) : null;
  const eol = detectEol(modified ?? original ?? '');
  return { ...base, original, modified, ...(eol ? { eol } : {}) };
}
