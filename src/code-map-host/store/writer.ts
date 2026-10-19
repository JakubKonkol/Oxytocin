import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

/** Temp files share the destination filesystem. A failed rename never truncates the previous file. */
export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await rejectLink(path);
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
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

export async function publishSnapshot(
  root: string,
  snapshot: {
    graph: CodeMapGraph;
    map: string;
    manifest: CodeMapManifest;
    cache?: ReadonlyMap<string, string>;
    liveCacheKeys?: ReadonlySet<string>;
  },
  assertOwned: () => Promise<void>,
): Promise<CodeMapManifest> {
  const writeStart = performance.now();
  const directory = await safeDirectory(root, ['.oxy', 'code-map']);
  const graph = `${JSON.stringify(CodeMapGraphSchema.parse(snapshot.graph))}\n`;
  const manifest = CodeMapManifestSchema.parse({ ...snapshot.manifest, graphSha256: sha256(graph) });
  let plannedBytes =
    Buffer.byteLength(graph) + Buffer.byteLength(snapshot.map) + Buffer.byteLength(JSON.stringify(manifest));
  for (const value of snapshot.cache?.values() ?? []) plannedBytes += Buffer.byteLength(value);
  const dirtyKeys = new Set(snapshot.cache?.keys());
  for (const file of await dataFiles(directory)) {
    if (['graph.json', 'MAP.md', 'manifest.json'].some((name) => file.path === join(directory, name))) continue;
    const hash = /([a-f0-9]{64})\.json$/.exec(file.path)?.[1];
    if (hash && (dirtyKeys.has(hash) || (snapshot.liveCacheKeys && !snapshot.liveCacheKeys.has(hash)))) continue;
    plannedBytes += file.bytes;
  }
  if (plannedBytes > CODE_MAP_LIMITS.bytes) throw new CodeMapLimitError();
  await assertOwned();
  const pendingCache = [...(snapshot.cache ?? [])];
  for (let offset = 0; offset < pendingCache.length; offset += 32) {
    await assertOwned();
    const outcomes = await Promise.allSettled(
      pendingCache.slice(offset, offset + 32).map(async ([hash, value]) => {
        CodeMapHashSchema.parse(hash);
        const cache = await safeDirectory(root, ['.oxy', 'code-map', 'cache', hash.slice(0, 2)]);
        await atomicWrite(join(cache, `${hash}.json`), value);
      }),
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
  if (snapshot.cache) {
    const cache = await safeDirectory(root, ['.oxy', 'code-map', 'cache']);
    for (const file of await dataFiles(cache)) {
      const match = /([a-f0-9]{64})\.json$/.exec(file.path);
      if (match && !(snapshot.liveCacheKeys ?? snapshot.cache).has(match[1]!)) await rm(file.path);
    }
  }
  if ((await dataSize(directory)) > CODE_MAP_LIMITS.bytes) throw new CodeMapLimitError();
  return manifest;
}
