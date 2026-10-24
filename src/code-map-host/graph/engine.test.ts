import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { extractTypeScript } from '../extract/typescript';
import { EXTRACTOR_VERSION } from '../extract/record';
import { buildSearchData } from '../extract/search-data';
import { CodeSearch } from '../query/search';
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
    // The parser worker attaches the same search postings to every parsed record.
    const record = extractTypeScript(path, source, tree);
    record.search = buildSearchData(source, record.symbols);
    return record;
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
      const contents = gunzipSync(await readFile(path)).toString('utf8');
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
  describe('search corpus', () => {
    const question = (target: GraphEngine, text: string) => {
      const snapshot = target.snapshot()!;
      return new CodeSearch(snapshot.graph, snapshot.corpus).search(text, undefined, 8).matches.map((m) => m.id);
    };
    it('keeps body terms out of graph.json, caches them with the record and pins each snapshot to its generation', async () => {
      const root = await temporary(),
        target = await engine(root),
        sources = new Map([
          ['a.ts', 'export function first() { return bodyonlyalpha; }'],
          ['notes.md', '# Notes\n\nResidualnotesword explains the plan.\n'],
        ]);
      const first = await publish(target, sources);
      const before = target.snapshot()!;
      expect(before.manifest.generation).toBe(first.manifest.generation);
      const graphText = await readFile(join(root, '.oxy/code-map/graph.json'), 'utf8');
      expect(graphText).not.toContain('bodyonlyalpha');
      expect(graphText).not.toContain('"search"');
      const records = await Promise.all(
        (await cacheFiles(root)).map(async (path) => gunzipSync(await readFile(path)).toString('utf8')),
      );
      expect(records.every((text) => text.includes('"search"'))).toBe(true);
      expect(question(target, 'bodyonlyalpha')).toEqual(['s:a.ts#function:first']);
      expect(question(target, 'residualnotesword')).toEqual(['f:notes.md']);

      sources.set('a.ts', 'export function first() { return bodyonlybeta; }');
      await publish(target, sources, ['a.ts']);
      const after = target.snapshot()!;
      expect(after.manifest.generation).toBe(before.manifest.generation + 1);
      expect(after.corpus).not.toBe(before.corpus);
      // The earlier generation keeps answering from its own graph and corpus, whatever was published since.
      const old = new CodeSearch(before.graph, before.corpus);
      expect(old.search('bodyonlyalpha', undefined, 3).matches.map((m) => m.path)).toEqual(['a.ts']);
      expect(old.search('bodyonlybeta', undefined, 3).matches).toEqual([]);
      expect(question(target, 'bodyonlybeta')).toEqual(['s:a.ts#function:first']);
      expect(question(target, 'bodyonlyalpha')).toEqual([]);
      // A checkpoint without changes returns the same pinned pair.
      await publish(target, sources, []);
      expect(target.snapshot()!.corpus).toBe(after.corpus);
    });
    it('answers identically after an incremental update, a cold build and a restart from the cache', async () => {
      const incrementalRoot = await temporary(),
        coldRoot = await temporary();
      const sources = new Map([
        ['a.ts', 'export function first() { return shiftPlain; }'],
        ['b.ts', "import {first} from './a'; export function run() { first(); /* newline handling */ }"],
        ['c.ts', 'export const flags = { shiftKey: true };'],
      ]);
      const incremental = await engine(incrementalRoot);
      await publish(incremental, sources);
      sources.set('a.ts', 'export function first() { return shiftKey && newline; }');
      sources.delete('c.ts');
      sources.set('d.ts', 'export function later() { /* newline after shiftKey */ }');
      await publish(incremental, sources, ['a.ts', 'd.ts']);
      const cold = await engine(coldRoot);
      await publish(cold, sources);
      const reopened = await engine(incrementalRoot);
      const dump = (target: GraphEngine) => JSON.stringify([...target.snapshot()!.corpus]);
      expect(dump(incremental)).toBe(dump(cold));
      expect(dump(reopened)).toBe(dump(cold));
      for (const text of ['shiftKey newline', 'newline handling', 'later', 'shift plain', 'first run'])
        for (const other of [cold, reopened]) expect(question(incremental, text)).toEqual(question(other, text));
      expect(question(incremental, 'shiftKey newline')).not.toEqual([]);
    });
    it('reparses cached records of another extractor version and recovers their search terms', async () => {
      const root = await temporary(),
        sources = new Map([['a.ts', 'export function first() { return versionedword; }']]);
      await publish(await engine(root), sources);
      for (const path of await cacheFiles(root)) {
        const record = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as Record<string, unknown>;
        record.version = EXTRACTOR_VERSION - 1;
        delete record.search;
        await writeFile(path, gzipSync(JSON.stringify(record)));
      }
      const reopened = await engine(root);
      // Records that cannot be trusted are not used for search either.
      expect(reopened.snapshot()!.corpus.size).toBe(0);
      parse.mockClear();
      await publish(reopened, sources);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(question(reopened, 'versionedword')).toEqual(['s:a.ts#function:first']);
    });
  });

  describe('deferred persistence of small edits', () => {
    const many = () =>
      new Map(
        Array.from({ length: 320 }, (_, index) => [`m${index}.ts`, `export function f${index}() { return ${index}; }`]),
      );
    const diskGraph = (root: string) => readFile(join(root, '.oxy/code-map/graph.json'), 'utf8');

    it('publishes a small edit in memory first and writes byte-identical files after the burst', async () => {
      const root = await temporary(),
        coldRoot = await temporary();
      const sources = many();
      const live = await engine(root);
      await publish(live, sources);
      const first = await diskGraph(root);
      sources.set('m7.ts', 'export function renamedSeven() { return 7; }');
      const published = await publish(live, sources, ['m7.ts']);
      expect(published.manifest.generation).toBe(2);
      expect(live.snapshot()!.graph.symbols.map((symbol) => symbol.name)).toContain('renamedSeven');
      // The disk still holds the previous generation until the write happens.
      expect(await diskGraph(root)).toBe(first);
      await live.flush();
      const cold = await engine(coldRoot);
      await publish(cold, sources);
      expect(await diskGraph(root)).toBe(await diskGraph(coldRoot));
      expect(await readFile(join(root, '.oxy/code-map/MAP.md'), 'utf8')).toBe(
        await readFile(join(coldRoot, '.oxy/code-map/MAP.md'), 'utf8'),
      );
      const manifest = JSON.parse(await readFile(join(root, '.oxy/code-map/manifest.json'), 'utf8')) as {
        generation: number;
        graphSha256: string;
      };
      expect(manifest).toMatchObject({ generation: 2, graphSha256: sha256(await diskGraph(root)) });
      // A new engine on the same data reads the flushed generation.
      expect((await engine(root)).snapshot()!.manifest.generation).toBe(2);
    });

    it('writes immediately in small projects and for bulk changes, and nothing while held', async () => {
      const small = await temporary();
      const tiny = new Map([['a.ts', 'export function a() {}']]);
      const target = await engine(small);
      await publish(target, tiny);
      tiny.set('a.ts', 'export function b() {}');
      await publish(target, tiny, ['a.ts']);
      expect(await diskGraph(small)).toContain('"name":"b"');

      const root = await temporary();
      const sources = many();
      const live = await engine(root);
      await publish(live, sources);
      for (const path of sources.keys()) sources.set(path, `${sources.get(path)!} // edited`);
      await publish(live, sources);
      // Bulk change: persisted before publishing, so nothing is pending.
      const before = await diskGraph(root);
      expect(live.snapshot()!.manifest.generation).toBe(2);
      expect(JSON.parse(await readFile(join(root, '.oxy/code-map/manifest.json'), 'utf8'))).toMatchObject({
        generation: 2,
      });
      sources.set('m1.ts', 'export function held() {}');
      live.holdPersistence(true);
      await publish(live, sources, ['m1.ts']);
      await live.flush();
      expect(await diskGraph(root)).toBe(before);
      live.holdPersistence(false);
      await live.flush();
      expect(await diskGraph(root)).toContain('"name":"held"');
    });
  });
});
