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
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected link in Code Map data');
    if (entry.isDirectory()) files.push(...(await dataFiles(path)));
    else {
      const info = await stat(path);
      files.push({ path, bytes: info.size, modified: info.mtimeMs });
    }
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
  snapshot: { graph: CodeMapGraph; map: string; manifest: CodeMapManifest; cache?: ReadonlyMap<string, string> },
  assertOwned: () => Promise<void>,
): Promise<void> {
  const directory = await safeDirectory(root, ['.oxy', 'code-map']);
  const graph = `${JSON.stringify(CodeMapGraphSchema.parse(snapshot.graph))}\n`;
  const manifest = CodeMapManifestSchema.parse({ ...snapshot.manifest, graphSha256: sha256(graph) });
  let plannedBytes =
    Buffer.byteLength(graph) + Buffer.byteLength(snapshot.map) + Buffer.byteLength(JSON.stringify(manifest));
  for (const value of snapshot.cache?.values() ?? []) plannedBytes += Buffer.byteLength(value);
  if (plannedBytes > CODE_MAP_LIMITS.bytes) throw new Error('Code Map limit reached — add exclusions');
  await assertOwned();
  for (const [hash, value] of snapshot.cache ?? []) {
    CodeMapHashSchema.parse(hash);
    const cache = await safeDirectory(root, ['.oxy', 'code-map', 'cache', hash.slice(0, 2)]);
    await atomicWrite(join(cache, `${hash}.json`), value);
  }
  for (const [file, value] of [
    ['graph.json', graph],
    ['MAP.md', snapshot.map],
    ['manifest.json', `${JSON.stringify(manifest)}\n`],
  ] as const) {
    await assertOwned();
    await atomicWrite(join(directory, file), value);
  }
  if (snapshot.cache) {
    const cache = await safeDirectory(root, ['.oxy', 'code-map', 'cache']);
    for (const file of await dataFiles(cache)) {
      const match = /([a-f0-9]{64})\.json$/.exec(file.path);
      if (match && !snapshot.cache.has(match[1]!)) await rm(file.path);
    }
  }
  if ((await dataSize(directory)) > CODE_MAP_LIMITS.bytes) throw new Error('Code Map limit reached — add exclusions');
}
