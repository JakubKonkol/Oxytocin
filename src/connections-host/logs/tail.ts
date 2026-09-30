import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { OxyError } from '@shared/errors';
import { nameGlob } from '@shared/utils/glob';
import { projectPath } from '../db/target';

const MAX_LINES = 2000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CHUNK = 64 * 1024;

/** The file a log resource points at: the path itself, or the newest file matching a glob in its name. */
export async function resolveLogFile(root: string, configured: string): Promise<string> {
  const full = projectPath(root, configured.trim());
  const name = basename(full);
  if (!/[*?]/.test(name)) return full;
  const dir = dirname(full);
  if (/[*?]/.test(dir)) throw new OxyError('INVALID', 'Only the file name may contain * or ? (not the folder).');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new OxyError('NOT_FOUND', `The folder ${dir} does not exist.`);
  }
  const re = nameGlob(name);
  let newest: { path: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!re.test(entry)) continue;
    const info = await stat(join(dir, entry)).catch(() => null);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.mtime))
      newest = { path: join(dir, entry), mtime: info.mtimeMs };
  }
  if (!newest) throw new OxyError('NOT_FOUND', `No file matches ${configured}.`);
  return newest.path;
}

/** The last `lines` lines of a log file (read from the end), optionally only those matching `grep`. */
export async function tailLog(o: { root: string; path: string; lines: number; grep?: string }): Promise<string> {
  const wanted = Math.max(1, Math.min(MAX_LINES, Math.round(o.lines) || 100));
  let filter: RegExp | undefined;
  if (o.grep) {
    try {
      filter = new RegExp(o.grep, 'i');
    } catch (e) {
      throw new OxyError('INVALID', `Invalid grep pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const file = await resolveLogFile(o.root, o.path);
  const handle = await open(file, 'r').catch(() => {
    throw new OxyError('NOT_FOUND', `${file} could not be opened.`);
  });
  try {
    const { size, mtime } = await handle.stat();
    const found: string[] = [];
    let position = size;
    let read = 0;
    let rest = '';
    while (position > 0 && found.length < wanted && read < MAX_READ_BYTES) {
      const length = Math.min(CHUNK, position);
      position -= length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, position);
      read += length;
      const text = buf.toString('utf8') + rest;
      const parts = text.split(/\r?\n/);
      rest = position > 0 ? parts.shift()! : '';
      for (let i = parts.length - 1; i >= 0 && found.length < wanted; i--) {
        const line = parts[i]!;
        if (found.length === 0 && line === '' && i === parts.length - 1) continue;
        if (!filter || filter.test(line)) found.push(line);
      }
    }
    if (position === 0 && rest && found.length < wanted && (!filter || filter.test(rest))) found.push(rest);
    found.reverse();
    let body = found.join('\n');
    if (Buffer.byteLength(body) > MAX_OUTPUT_BYTES) body = `…${body.slice(-MAX_OUTPUT_BYTES)}`;
    const scope = read < size ? ` (searched the last ${Math.round(read / 1024)} KB)` : '';
    return `${file} — ${size.toLocaleString('en-US')} bytes, modified ${mtime.toISOString()}; ${found.length} line${found.length === 1 ? '' : 's'}${filter ? ` matching /${o.grep}/i` : ''}${scope}:\n${body}`;
  } finally {
    await handle.close();
  }
}
