import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  CODE_MAP_LIMITS,
  CodeMapGraphSchema,
  CodeMapHashSchema,
  CodeMapManifestSchema,
  type CodeMapGraph,
  type CodeMapManifest,
} from '@shared/domain/code-map';
import { hasCode, rejectLink, safeDirectory } from './paths';
import { CodeMapLimitError } from '../enumerate';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Temp files share the destination filesystem. A failed rename never truncates the previous file. Derived records
 * that are validated on read may skip the flush: a torn record is detected and re-extracted.
 */
export async function atomicWrite(path: string, content: string | Uint8Array, flush = true): Promise<void> {
  await rejectLink(path);
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    if (flush) await handle.sync();
  } finally {
    await handle.close();
  }
  const started = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if ((!hasCode(error, 'EPERM') && !hasCode(error, 'EBUSY')) || Date.now() - started >= 2000) throw error;
        await delay(Math.min(20 * 2 ** attempt, 200, Math.max(1, 2000 - (Date.now() - started))));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function dataFiles(directory: string): Promise<{ path: string; bytes: number; modified: number }[]> {
  const files: { path: string; bytes: number; modified: number }[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  });
  for (let offset = 0; offset < entries.length; offset += 32) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 32).map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Unexpected link in Code Map data');
        if (entry.isDirectory()) return dataFiles(path);
        const info = await stat(path).catch((error: unknown) => {
          if (hasCode(error, 'ENOENT')) return null;
          throw error;
        });
        return info ? [{ path, bytes: info.size, modified: info.mtimeMs }] : [];
      }),
    );
    for (const filesInEntry of batch) files.push(...filesInEntry);
  }
  return files;
}

export async function cleanTemporaryFiles(directory: string, now = Date.now()): Promise<void> {
  for (const file of await dataFiles(directory))
    if (/\.tmp-[^/\\]+$/.test(file.path) && now - file.modified > 3_600_000) await rm(file.path, { force: true });
}
export async function dataSize(directory: string): Promise<number> {
  return (await dataFiles(directory)).reduce((size, file) => size + file.bytes, 0);
}

export async function loadSnapshot(
  directory: string,
): Promise<{ graph: CodeMapGraph; manifest: CodeMapManifest } | null> {
  try {
    await Promise.all(['graph.json', 'manifest.json'].map((file) => rejectLink(join(directory, file))));
    const sizes = await Promise.all(['graph.json', 'manifest.json'].map((file) => stat(join(directory, file))));
    if (sizes[0]!.size > CODE_MAP_LIMITS.bytes || sizes[1]!.size > 1024 * 1024) return null;
    const [graphText, manifestText] = await Promise.all([
      readFile(join(directory, 'graph.json'), 'utf8'),
      readFile(join(directory, 'manifest.json'), 'utf8'),
    ]);
    const manifest = CodeMapManifestSchema.parse(JSON.parse(manifestText));
    if (sha256(graphText) !== manifest.graphSha256) return null;
    return { graph: CodeMapGraphSchema.parse(JSON.parse(graphText)), manifest };
  } catch {
    return null;
  }
}

const CACHE_FILE = /^([a-f0-9]{64})\.json\.gz$/;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
/**
 * Compressed extraction records keyed by content hash. Sizes are indexed once and then maintained in memory, so a
 * publication never walks the cache directory; this host is the only writer while it owns the map.
 */
export class CacheStore {
  private sizes: Map<string, number> | undefined;
  private readonly directories = new Map<string, Promise<string>>();
  constructor(private readonly root: string) {}
  private directory(key: string, create: boolean): Promise<string> {
    const prefix = key.slice(0, 2);
    let directory = this.directories.get(prefix);
    if (!directory) {
      directory = safeDirectory(this.root, ['.oxy', 'code-map', 'cache', prefix], create);
      this.directories.set(prefix, directory);
      directory.catch(() => this.directories.delete(prefix));
    }
    return directory;
  }
  /** Indexes existing records and removes files of any other format (older record versions). */
  async load(): Promise<void> {
    const sizes = new Map<string, number>();
    let cache: string;
    try {
      cache = await safeDirectory(this.root, ['.oxy', 'code-map', 'cache'], false);
    } catch {
      this.sizes = sizes;
      return;
    }
    for (const file of await dataFiles(cache)) {
      const name = basename(file.path);
      const match = CACHE_FILE.exec(name);
      if (match && basename(dirname(file.path)) === match[1]!.slice(0, 2)) sizes.set(match[1]!, file.bytes);
      else if (!/\.tmp-/.test(name)) await rm(file.path, { force: true });
    }
    this.sizes = sizes;
  }
  get bytes(): number {
    let total = 0;
    for (const size of this.sizes?.values() ?? []) total += size;
    return total;
  }
  sizeOf(key: string): number {
    return this.sizes?.get(key) ?? 0;
  }
  has(key: string): boolean {
    return this.sizes?.has(key) ?? false;
  }
  keys(): string[] {
    return [...(this.sizes?.keys() ?? [])];
  }
  async read(key: string): Promise<string | null> {
    if (this.sizes && !this.sizes.has(key)) return null;
    try {
      const file = join(await this.directory(key, false), `${key}.json.gz`);
      await rejectLink(file);
      const compressed = await readFile(file);
      if (compressed.byteLength > MAX_RECORD_BYTES) return null;
      return (await promisify(gunzip)(compressed, { maxOutputLength: MAX_RECORD_BYTES })).toString('utf8');
    } catch {
      return null;
    }
  }
  static compress(value: string): Promise<Buffer> {
    return promisify(gzip)(Buffer.from(value, 'utf8'), { level: 6 });
  }
  async write(key: string, compressed: Uint8Array): Promise<void> {
    CodeMapHashSchema.parse(key);
    await atomicWrite(join(await this.directory(key, true), `${key}.json.gz`), compressed, false);
    this.sizes?.set(key, compressed.byteLength);
  }
  async prune(live: ReadonlySet<string>): Promise<void> {
    for (const key of this.keys())
      if (!live.has(key)) {
        await rm(join(await this.directory(key, false), `${key}.json.gz`), { force: true });
        this.sizes?.delete(key);
      }
  }
}

export async function publishSnapshot(
  root: string,
  snapshot: {
    /** A graph object is validated; serialized text must come from a graph built by this host. */
    graph: CodeMapGraph | string;
    map: string;
    manifest: CodeMapManifest;
    cache?: ReadonlyMap<string, string>;
    liveCacheKeys?: ReadonlySet<string>;
  },
  assertOwned: () => Promise<void>,
  store?: CacheStore,
): Promise<{ manifest: CodeMapManifest; bytes: number }> {
  const writeStart = performance.now();
  const directory = await safeDirectory(root, ['.oxy', 'code-map']);
  if (!store) {
    store = new CacheStore(root);
    await store.load();
  }
  const graph =
    typeof snapshot.graph === 'string'
      ? snapshot.graph
      : `${JSON.stringify(CodeMapGraphSchema.parse(snapshot.graph))}\n`;
  const manifest = CodeMapManifestSchema.parse({ ...snapshot.manifest, graphSha256: sha256(graph) });
  const pendingCache: [string, Buffer][] = [];
  for (const [key, value] of snapshot.cache ?? []) pendingCache.push([key, await CacheStore.compress(value)]);
  const live = snapshot.liveCacheKeys ?? new Set(snapshot.cache?.keys());
  const dirty = new Set(snapshot.cache?.keys());
  let plannedBytes =
    Buffer.byteLength(graph) + Buffer.byteLength(snapshot.map) + Buffer.byteLength(JSON.stringify(manifest));
  for (const [, value] of pendingCache) plannedBytes += value.byteLength;
  for (const key of store.keys()) if (live.has(key) && !dirty.has(key)) plannedBytes += store.sizeOf(key);
  if (plannedBytes > CODE_MAP_LIMITS.bytes) throw new CodeMapLimitError();
  await assertOwned();
  for (let offset = 0; offset < pendingCache.length; offset += 32) {
    await assertOwned();
    const outcomes = await Promise.allSettled(
      pendingCache.slice(offset, offset + 32).map(([key, value]) => store.write(key, value)),
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected')
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
  for (const [file, value] of [
    ['graph.json', graph],
    ['MAP.md', snapshot.map],
    ['manifest.json', `${JSON.stringify(manifest)}\n`],
  ] as const) {
    await assertOwned();
    if (file === 'manifest.json') {
      manifest.durationsMs.write = performance.now() - writeStart;
      await atomicWrite(join(directory, file), `${JSON.stringify(manifest)}\n`);
    } else await atomicWrite(join(directory, file), value);
  }
  if (snapshot.cache) await store.prune(live);
  const bytes =
    Buffer.byteLength(graph) +
    Buffer.byteLength(snapshot.map) +
    Buffer.byteLength(`${JSON.stringify(manifest)}\n`) +
    store.bytes;
  if (bytes > CODE_MAP_LIMITS.bytes) throw new CodeMapLimitError();
  return { manifest, bytes };
}
