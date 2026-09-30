import { randomBytes } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DatabaseEngine, ImportCandidate } from '@shared/domain/project-resources';
import { type Detected, detectInFile, fileKind, prismaHints } from './detect';

const IGNORED = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.idea',
  '.vs',
  'coverage',
  'packages-cache',
]);
const MAX_DEPTH = 4;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const SQLITE_EXT = /\.(sqlite3?|db|s3db)$/i;
const SQLITE_HEADER = 'SQLite format 3\0';
const SECRET_TTL_MS = 30 * 60_000;

interface Found {
  config: string[];
  prisma: string[];
  sqlite: string[];
}

async function walk(root: string): Promise<Found> {
  const found: Found = { config: [], prisma: [], sqlite: [] };
  let files = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files > MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > MAX_FILES) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name) && !(e.name.startsWith('.') && e.name !== '.config')) await visit(path, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const kind = fileKind(e.name);
      if (kind === 'prisma') found.prisma.push(path);
      else if (kind) found.config.push(path);
      else if (SQLITE_EXT.test(e.name)) found.sqlite.push(path);
      else continue;
      files++;
    }
  };
  await visit(root, 0);
  return found;
}

async function isSqliteFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const buf = Buffer.alloc(16);
    await handle.read(buf, 0, 16, 0);
    return buf.toString('latin1') === SQLITE_HEADER;
  } finally {
    await handle.close();
  }
}

const readSmall = async (path: string): Promise<string | null> => {
  const info = await stat(path).catch(() => null);
  if (!info || info.size > MAX_FILE_BYTES) return null;
  return readFile(path, 'utf8').catch(() => null);
};

/** Scans a project for connection strings; secrets stay in this process (see `secretFor`). */
export class ImportScanner {
  private readonly secrets = new Map<string, { value: string; root: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async scan(root: string): Promise<ImportCandidate[]> {
    this.prune();
    const found = await walk(root);
    const hints = new Map<string, DatabaseEngine>();
    for (const path of found.prisma) {
      const text = await readSmall(path);
      if (text) for (const [k, v] of prismaHints(text)) hints.set(k, v);
    }
    const out: ImportCandidate[] = [];
    const rel = (path: string) => relative(root, path).split(sep).join('/');
    for (const path of found.config) {
      const text = await readSmall(path);
      if (!text) continue;
      for (const d of detectInFile(rel(path), text, hints)) out.push(this.candidate(root, rel(path), d));
    }
    for (const path of found.sqlite.slice(0, 20)) {
      if (!(await isSqliteFile(path))) continue;
      out.push(
        this.candidate(root, rel(path), {
          source: `${rel(path)} (SQLite file)`,
          name: rel(path).split('/').pop()!.replace(SQLITE_EXT, ''),
          connection: { engine: 'sqlite', path: rel(path), options: {} },
        }),
      );
    }
    // The same connection found twice (e.g. .env and .env.local): keep the first.
    const seen = new Set<string>();
    return out.filter((c) => {
      const key = JSON.stringify([c.engine, c.host, c.port, c.database, c.user, c.path]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private candidate(root: string, file: string, d: Detected): ImportCandidate {
    const token = randomBytes(12).toString('base64url');
    if (d.secret !== undefined) this.secrets.set(token, { value: d.secret, root, expires: this.now() + SECRET_TTL_MS });
    const c = d.connection;
    return {
      source: d.source,
      file,
      engine: c.engine,
      name: d.name,
      ...(c.host ? { host: c.host } : {}),
      ...(c.port ? { port: c.port } : {}),
      ...(c.database ? { database: c.database } : {}),
      ...(c.user ? { user: c.user } : {}),
      ...(Object.keys(c.options).length ? { options: c.options } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(c.tls ? { tls: c.tls } : {}),
      hasSecret: d.secret !== undefined,
      ...(d.reference && fileKind(file.split('/').pop() ?? '') === 'env'
        ? { reference: { file, variable: d.reference.variable } }
        : {}),
      token,
    };
  }

  /** The secret of a candidate from a recent scan of the same project (null when unknown or expired). */
  secretFor(root: string, token: string): string | null {
    this.prune();
    const entry = this.secrets.get(token);
    return entry && entry.root === root ? entry.value : null;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.secrets) if (v.expires < now) this.secrets.delete(k);
  }
}
