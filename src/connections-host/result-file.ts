import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { RESULT_FILES_DIR } from '@shared/domain/project-resources';
import { OxyError } from '@shared/errors';

/** A result saved for the agent to read with its own tools. */
export interface SavedResult {
  /** Absolute path. */
  path: string;
  /** `.oxy/results/<file>`, relative to the project root. */
  relativePath: string;
  bytes: number;
}

/** Saved results older than this are removed when the next one is saved. */
export const RESULT_FILE_KEEP_MS = 24 * 60 * 60_000;
/** At most this many saved results are kept per project (the oldest go first). */
export const RESULT_FILE_KEEP_COUNT = 50;
/** The preview of a saved result shown in the reply. */
export const RESULT_PREVIEW_BYTES = 8 * 1024;

const isInside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

const hasCode = (e: unknown, code: string) => (e as { code?: unknown } | null)?.code === code;

/** `<root>/.oxy/results`, created when missing; refuses links that lead out of the project. */
async function resultsDirectory(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  let boundary = canonicalRoot;
  let path = canonicalRoot;
  for (const segment of RESULT_FILES_DIR.split('/')) {
    path = join(path, segment);
    await mkdir(path).catch((e: unknown) => {
      if (!hasCode(e, 'EEXIST')) throw e;
    });
    path = await realpath(path);
    if (!isInside(boundary, path) || !(await lstat(path)).isDirectory())
      throw new OxyError('INVALID', `${RESULT_FILES_DIR} in the project is not a plain folder.`);
    boundary = path;
  }
  // The folder ignores itself, so saved results never show up as changes even when `.oxy` is not ignored.
  await writeFile(join(path, '.gitignore'), '# Oxytocin: results saved for agents (removed after a day)\n*\n', {
    flag: 'wx',
  }).catch((e: unknown) => {
    if (!hasCode(e, 'EEXIST')) throw e;
  });
  return path;
}

/** Removes saved results older than a day and the oldest beyond the count (keeping room for one more). */
async function prune(dir: string, now: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: { path: string; at: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitignore') continue;
    const path = join(dir, entry.name);
    const info = await lstat(path).catch(() => null);
    if (info) files.push({ path, at: info.mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  const remove = files.filter((f, i) => now - f.at > RESULT_FILE_KEEP_MS || i >= RESULT_FILE_KEEP_COUNT - 1);
  await Promise.all(remove.map((f) => rm(f.path, { force: true }).catch(() => undefined)));
}

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'result';

const pad = (n: number) => String(n).padStart(2, '0');

/** Saves a result in the project's `.oxy/results` (only the user can read it) and returns where it went. */
export async function saveResultFile(o: {
  root: string;
  label: string;
  extension: string;
  data: string | Buffer;
  now?: Date;
}): Promise<SavedResult> {
  const now = o.now ?? new Date();
  const dir = await resultsDirectory(o.root);
  await prune(dir, now.getTime());
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension = o.extension.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'txt';
  const name = `${stamp}-${slug(o.label)}-${randomBytes(3).toString('hex')}.${extension}`;
  const path = join(dir, name);
  await writeFile(path, o.data, { flag: 'wx', mode: 0o600 });
  return {
    path,
    relativePath: `${RESULT_FILES_DIR}/${name}`,
    bytes: typeof o.data === 'string' ? Buffer.byteLength(o.data) : o.data.length,
  };
}

/** 1,536 → "1.5 KB"; 3,500,000 → "3.3 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** The start of a text, at most `maxBytes` UTF-8 bytes, cut at a line end when one is near. */
export function previewOf(text: string, maxBytes = RESULT_PREVIEW_BYTES): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  // A character split by the byte cut decodes as U+FFFD: drop it.
  cut = cut.replace(/�$/, '');
  const line = cut.lastIndexOf('\n');
  return `${line > cut.length / 2 ? cut.slice(0, line) : cut}\n…`;
}

const typeName = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;

/**
 * The shape of a JSON value as a few indented lines (keys, types, array lengths), so the agent can write a `jq`
 * filter or a narrower request without reading the whole file.
 */
export function jsonOutline(value: unknown, maxLines = 40): string {
  const lines: string[] = [];
  let cut = false;
  const push = (line: string) => {
    if (lines.length >= maxLines) cut = true;
    else lines.push(line);
  };
  const describe = (v: unknown, indent: string, label: string, depth: number) => {
    if (cut) return;
    if (Array.isArray(v)) {
      const n = v.length.toLocaleString('en-US');
      const first: unknown = (v as unknown[]).find((x) => x !== null && x !== undefined);
      const items = [...new Set(v.slice(0, 50).map(typeName))].join(' | ') || 'nothing';
      if (first && typeof first === 'object' && !Array.isArray(first) && depth < 4) {
        push(`${indent}${label}array[${n}] of {`);
        // Keys of the first items together: optional keys show up too.
        const merged: Record<string, unknown> = {};
        for (const item of v.slice(0, 20))
          if (item && typeof item === 'object' && !Array.isArray(item))
            for (const [k, x] of Object.entries(item as Record<string, unknown>))
              if (!(k in merged) || merged[k] === null) merged[k] = x;
        describeObject(merged, `${indent}  `, depth + 1);
        push(`${indent}}`);
      } else if (Array.isArray(first) && depth < 4) {
        push(`${indent}${label}array[${n}] of`);
        describe(first, `${indent}  `, '', depth + 1);
      } else push(`${indent}${label}array[${n}] of ${items}`);
    } else if (v && typeof v === 'object') {
      if (depth >= 4) return push(`${indent}${label}object (${Object.keys(v).length} keys)`);
      push(`${indent}${label}{`);
      describeObject(v as Record<string, unknown>, `${indent}  `, depth + 1);
      push(`${indent}}`);
    } else push(`${indent}${label}${typeName(v)}`);
  };
  const describeObject = (o: Record<string, unknown>, indent: string, depth: number) => {
    const keys = Object.keys(o);
    for (const key of keys.slice(0, 30)) describe(o[key], indent, `${JSON.stringify(key)}: `, depth);
    if (keys.length > 30) push(`${indent}… ${keys.length - 30} more keys`);
  };
  describe(value, '', '', 0);
  if (cut) lines.push('…');
  return lines.join('\n');
}

/** The note at the top of a reply whose result went to a file. */
export function savedNote(saved: SavedResult, what: string): string {
  return `${what} saved in full (${formatSize(saved.bytes)}) to ${saved.relativePath}\n(${saved.path}). Read it with your file tools or jq instead of asking for it again; Oxytocin removes it after a day.`;
}

/** The note when a result could not be saved (the reply then shows what fits, as before). */
export function unsavedNote(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return `(The full result could not be saved to ${RESULT_FILES_DIR}: ${message}. Only what fits is shown.)`;
}
