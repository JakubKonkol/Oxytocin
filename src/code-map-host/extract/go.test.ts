import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { CodeMapGraphSchema } from '@shared/domain/code-map';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { FileRecordSchema, type FileRecord } from './record';
import { extractGo } from './go';
import { fileRecord, normalizedSource } from './files';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from '../graph/build';

let assets: string, runtime: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-go-'));
  await copyCodeMapAssets(assets);
  runtime = new ParserRuntime(assets);
});
afterAll(async () => {
  runtime.dispose();
  await rm(assets, { recursive: true, force: true });
});
const generator = { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` };
async function record(path: string, input: string) {
  const source = normalizedSource(input),
    tree = await runtime.parse(source, 'go');
  try {
    return FileRecordSchema.parse(extractGo(path, source, tree));
  } finally {
    tree.delete();
  }
}
it('binds a reviewed two-module workspace without inferring interface dispatch, unknown receivers or shadowed functions', async () => {
  const root = 'tests/fixtures/code-map/go-workspace',
    records = new Map<string, FileRecord>(),
    configs = new Map<string, ProjectConfig>();
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (!entry.name.endsWith('.json')) {
        const path = relative(root, absolute).replaceAll('\\', '/'),
          source = await readFile(absolute, 'utf8');
        records.set(path, path.endsWith('.go') ? await record(path, source) : fileRecord(path, source));
        const config = parseProjectConfig(path, source);
        if (config) configs.set(path, config);
      }
    }
  };
  await walk(root);
  const graph = buildGraph(records, configs, generator),
    byId = new Map(graph.symbols.map((s) => [s.id, s]));
  const calls = graph.edges
    .filter((e) => e.rel === 'calls')
    .map((e) => {
      const from = byId.get(e.from)!,
        to = byId.get(e.to)!;
      return [from.file.slice(2), from.name, to.file.slice(2), to.name];
    });
  const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8')) as {
    calls: string[][];
    unresolved: string[];
  };
  expect(calls.sort()).toEqual(expected.calls.sort());
  expect(
    graph.unresolved
      .filter((u) => u.rel === 'calls')
      .map((u) => u.target)
      .sort(),
  ).toEqual(expected.unresolved.sort());
  expect(graph.unresolved.find((u) => u.target === 'w.Save')?.reason).toBe('interface-dispatch');
  expect(graph.files.find((f) => f.path.endsWith('_test.go'))?.test).toBe(true);
  expect(graph.symbols.find((s) => s.name === 'hidden')?.exported).toBe(false);
  expect(graph.symbols.find((s) => s.name === 'main')?.buildTags).toEqual(['//go:build linux || windows']);
  expect(CodeMapGraphSchema.parse(graph)).toEqual(graph);
  expect(buildGraph(new Map([...records].reverse()), new Map([...configs].reverse()), generator)).toEqual(graph);
  const crlf = new Map<string, FileRecord>();
  for (const [p, r] of records)
    crlf.set(
      p,
      p.endsWith('.go') ? await record(p, (await readFile(join(root, p), 'utf8')).replaceAll('\n', '\r\n')) : r,
    );
  expect(buildGraph(crlf, configs, generator)).toEqual(graph);
});
it('keeps modules outside go.work external and records syntax errors and Unicode spans', async () => {
  const rec = await record('main.go', 'package main\nimport data "example.test/core"\nfunc main(){ data.New() }\n');
  const graph = buildGraph(new Map([['main.go', rec]]), new Map(), generator);
  expect(graph.packages[0]?.name).toBe('example.test/core');
  expect(graph.edges.filter((e) => e.rel === 'calls')).toEqual([]);
  expect((await record('broken.go', 'package main\nfunc Broken( {')).file.status).toBe('syntax-errors');
  const unicode = await record('unicode.go', 'package sample\nvar π = "😀"; func Run() {}\n');
  expect(unicode.symbols.find((s) => s.name === 'Run')?.span[1]).toBe(14);
});
it('does not bind test-only declarations, inaccessible methods or duplicate workspace module identities', async () => {
  const records = new Map<string, FileRecord>();
  for (const [path, source] of [
    ['core/api.go', 'package core\ntype Visible struct{}\nfunc(v Visible) hidden(){}\nfunc Exported(){}\n'],
    ['core/api_test.go', 'package core\nfunc TestOnly(){}\n'],
    [
      'app/main.go',
      'package main\nimport core "example.test/core"\nfunc main(){ core.TestOnly(); var v core.Visible; v.hidden(); core.Exported() }\n',
    ],
  ])
    records.set(path!, await record(path!, source!));
  const configs = new Map<string, ProjectConfig>([
    ['core/go.mod', { kind: 'go-module', data: { module: 'example.test/core' } }],
    ['app/go.mod', { kind: 'go-module', data: { module: 'example.test/app' } }],
    ['go.work', { kind: 'go-work', data: { uses: ['./core', './app'] } }],
  ]);
  const graph = buildGraph(records, configs, generator);
  expect(graph.edges.filter((e) => e.rel === 'calls')).toHaveLength(1);
  expect(graph.unresolved.map((u) => u.target).sort()).toEqual(['core.TestOnly', 'v.hidden']);
  configs.set('duplicate/go.mod', { kind: 'go-module', data: { module: 'example.test/core' } });
  configs.set('go.work', { kind: 'go-work', data: { uses: ['./core', './app', './duplicate'] } });
  expect(buildGraph(records, configs, generator).edges.filter((e) => e.rel === 'calls')).toEqual([]);
});
