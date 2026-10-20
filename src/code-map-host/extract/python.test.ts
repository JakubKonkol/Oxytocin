import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { CodeMapGraphSchema } from '@shared/domain/code-map';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { FileRecordSchema, type FileRecord } from './record';
import { extractPython } from './python';
import { fileRecord, normalizedSource } from './files';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from '../graph/build';

let assets: string, runtime: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-python-'));
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
    tree = await runtime.parse(source, 'python');
  try {
    return FileRecordSchema.parse(extractPython(path, source, tree));
  } finally {
    tree.delete();
  }
}
it('binds a reviewed src package, relative re-exports, self/base methods and namespace packages without guessing instances', async () => {
  const root = 'tests/fixtures/code-map/python-src',
    records = new Map<string, FileRecord>(),
    configs = new Map<string, ProjectConfig>();
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (!entry.name.endsWith('.json')) {
        const path = relative(root, absolute).replaceAll('\\', '/'),
          source = await readFile(absolute, 'utf8');
        records.set(path, path.endsWith('.py') ? await record(path, source) : fileRecord(path, source));
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
      return [basename(from.file), from.name, basename(to.file), to.name];
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
  expect(graph.symbols.find((s) => s.name === 'static')?.decorators).toEqual(['@staticmethod']);
  expect(graph.symbols.find((s) => s.name === 'helper')?.exported).toBe(false);
  expect(JSON.stringify([...records.values()])).not.toContain('PRIVATE_VALUE');
  expect(CodeMapGraphSchema.parse(graph)).toEqual(graph);
  expect(buildGraph(new Map([...records].reverse()), new Map([...configs].reverse()), generator)).toEqual(graph);
  const crlf = new Map<string, FileRecord>();
  for (const [p, r] of records)
    crlf.set(
      p,
      p.endsWith('.py')
        ? await record(p, '\ufeff' + (await readFile(join(root, p), 'utf8')).replaceAll('\n', '\r\n'))
        : r,
    );
  expect(buildGraph(crlf, configs, generator)).toEqual(graph);
});
it('honors configured source roots and avoids lexical shadowing and comprehension false positives', async () => {
  const records = new Map<string, FileRecord>();
  records.set('lib/custom/api.py', await record('lib/custom/api.py', 'def run():\n    return 1\n'));
  records.set(
    'main.py',
    await record(
      'main.py',
      'from custom.api import run\ndef use(run):\n    run()\ndef works():\n    run()\nvalues = [run() for run in []]\n',
    ),
  );
  const config = parseProjectConfig('pyproject.toml', '[tool.poetry]\npackages = [{include="custom", from="lib"}]\n')!;
  const graph = buildGraph(records, new Map([['pyproject.toml', config]]), generator);
  expect(graph.edges.filter((e) => e.rel === 'calls')).toHaveLength(1);
  expect(graph.unresolved.filter((u) => u.rel === 'calls')).toHaveLength(2);
  expect((await record('bad.py', 'def bad(:')).file.status).toBe('syntax-errors');
  const privacy = await record('privacy.py', 'class Public:\n    def _private(self):\n        pass\n');
  expect(
    buildGraph(new Map([['privacy.py', privacy]]), new Map(), generator).symbols.find((s) => s.name === '_private')
      ?.exported,
  ).toBe(false);
});
