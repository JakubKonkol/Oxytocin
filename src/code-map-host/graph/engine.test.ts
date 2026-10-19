import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { extractTypeScript } from '../extract/typescript';
import { normalizedSource } from '../extract/files';
import type { InventorySnapshot } from '../indexer';
import { GraphEngine } from './engine';
import { sha256 } from '../store/writer';

let assets: string;
let parser: ParserRuntime;
const roots: string[] = [];
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-engine-assets-'));
  await copyCodeMapAssets(assets);
  parser = new ParserRuntime(assets);
});
afterAll(async () => {
  parser?.dispose();
  if (assets) await rm(assets, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'oxy-engine-'));
  roots.push(root);
  return root;
}
const parse = vi.fn(async (path: string, source: string) => {
  source = normalizedSource(source);
  const tree = await parser.parse(source, 'typescript');
  try {
    return extractTypeScript(path, source, tree);
  } finally {
    tree.delete();
  }
});
async function engine(root: string) {
  const result = new GraphEngine({
    root,
    assets,
    version: 'test',
    excludedPaths: [],
    parser: { parse },
    assertOwned: () => Promise.resolve(),
  });
  await result.initialize();
  return result;
}
function inventory(sources: Map<string, string>): InventorySnapshot {
  return {
    files: new Map(
      [...sources].map(([path, source]) => [
        path,
        {
          sha256: sha256(source),
          metadata: { size: Buffer.byteLength(source), mtimeNs: '0', inode: '1', device: '1' },
        },
      ]),
    ),
    diagnostics: { skipped: [], failed: [], unresolved: [], truncated: false },
    skippedCount: 0,
    checkedAt: Date.now(),
    fullHash: true,
    enumerateMs: 0,
    readMs: 0,
  };
}
async function publish(target: GraphEngine, sources: Map<string, string>, changed = [...sources.keys()]) {
  target.start();
  for (const path of changed) await target.file(path, sources.get(path)!);
  return target.complete(inventory(sources), new AbortController().signal);
}
async function cacheFiles(root: string): Promise<string[]> {
  const directory = join(root, '.oxy/code-map/cache');
  const out: string[] = [];
  for (const prefix of await readdir(directory))
    for (const name of await readdir(join(directory, prefix))) out.push(join(directory, prefix, name));
  return out;
}

describe('Graph publication pipeline', () => {
  it('publishes byte-identical cold/incremental/rebuild results, removes dangling relations and caches only changed files', async () => {
    const root = await temporary(),
      coldRoot = await temporary();
    const sources = new Map([
      ['a.ts', 'export function first() {}'],
      ['b.ts', "import {first} from './a'; export function run() { first(); }"],
      ['package.json', '{"name":"fixture","main":"b.ts","scripts":{"private":"PRIVATE_CONFIGURATION"}}'],
    ]);
    const incremental = await engine(root);
    await publish(incremental, sources);
    sources.set('a.ts', 'export function changed() {}');
    await publish(incremental, sources, ['a.ts']);
    const cold = await engine(coldRoot);
    await publish(cold, sources);
    const text = await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8');
    expect(await readFile(join(coldRoot, '.oxy/code-map/graph.json'), 'utf8')).toBe(text);
    expect(await readFile(join(coldRoot, '.oxy/code-map/MAP.md'), 'utf8')).toBe(
      await readFile(join(root, '.oxy/code-map/MAP.md'), 'utf8'),
    );
    parse.mockClear();
    incremental.rebuild();
    await publish(incremental, sources);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8')).toBe(text);
    const caches = await cacheFiles(root);
    expect(caches).toHaveLength(3);
    for (const path of caches) {
      const contents = await readFile(path, 'utf8');
      expect(contents).not.toContain('PRIVATE_CONFIGURATION');
      expect(contents).not.toContain(root);
    }
    sources.delete('a.ts');
    const deleted = await publish(incremental, sources, []);
    expect(deleted.graph.files.some((file) => file.path === 'a.ts')).toBe(false);
    expect(deleted.graph.edges.some((edge) => edge.to.includes('a.ts'))).toBe(false);
  });
  it('keeps last good declarations stale on syntax errors and recovers when source is fixed', async () => {
    const root = await temporary(),
      target = await engine(root),
      sources = new Map([['a.ts', 'export function good() {}']]);
    await publish(target, sources);
    sources.set('a.ts', 'export function broken( {');
    const broken = await publish(target, sources);
    expect(broken.manifest.state).toBe('degraded');
    expect(broken.graph.symbols).toContainEqual(expect.objectContaining({ name: 'good', stale: true }));
    sources.set('a.ts', 'export function fixed() {}');
    const fixed = await publish(target, sources);
    expect(fixed.graph.symbols.map((symbol) => symbol.name)).toEqual(['fixed']);
    expect(fixed.manifest.state).toBe('ready');
  });
  it('rebuilds corrupt graph/cache artifacts instead of trusting them', async () => {
    const root = await temporary(),
      target = await engine(root),
      sources = new Map([['a.ts', 'export function good() {} export function entry() { good(); }']]);
    const first = await publish(target, sources);
    const expected = await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8');
    await writeFile((await cacheFiles(root))[0]!, '{');
    const missingRecord = await engine(root);
    parse.mockClear();
    await publish(missingRecord, sources);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8')).toBe(expected);
    await writeFile((await cacheFiles(root))[0]!, '{');
    await writeFile(join(root, '.oxy/code-map/graph.json'), '{}');
    const repaired = await engine(root);
    parse.mockClear();
    const result = await publish(repaired, sources);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.manifest.generation).toBeGreaterThan(first.manifest.generation);
    expect(await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8')).toBe(expected);
  });
});
