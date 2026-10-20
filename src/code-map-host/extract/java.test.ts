import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { CodeMapGraphSchema } from '@shared/domain/code-map';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { FileRecordSchema, type FileRecord } from './record';
import { extractJava } from './java';
import { fileRecord, normalizedSource } from './files';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from '../graph/build';

let assets: string, runtime: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-java-'));
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
    tree = await runtime.parse(source, 'java');
  try {
    return FileRecordSchema.parse(extractJava(path, source, tree));
  } finally {
    tree.delete();
  }
}
it('resolves a reviewed multi-module Java fixture with declared fields, locals, static imports and base overloads', async () => {
  const root = 'tests/fixtures/code-map/java-maven',
    records = new Map<string, FileRecord>(),
    configs = new Map<string, ProjectConfig>();
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (!entry.name.endsWith('.json')) {
        const path = relative(root, absolute).replaceAll('\\', '/'),
          source = await readFile(absolute, 'utf8');
        records.set(path, path.endsWith('.java') ? await record(path, source) : fileRecord(path, source));
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
      return [byId.get(from.owner!)!.name, from.name, byId.get(to.owner!)!.name, to.name];
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
  expect(graph.edges.filter((e) => e.rel === 'extends')).toHaveLength(1);
  expect(graph.edges.filter((e) => e.rel === 'implements')).toHaveLength(1);
  expect(graph.groups.filter((g) => g.kind === 'project')).toHaveLength(3);
  expect(graph.symbols.find((s) => s.name === 'Ticket')?.kind).toBe('class');
  expect(graph.symbols.find((s) => s.name === 'Flag')?.kind).toBe('interface');
  expect(graph.symbols.find((s) => s.name === 'local')?.visibility).toBe('private');
  expect(CodeMapGraphSchema.parse(graph)).toEqual(graph);
  expect(buildGraph(new Map([...records].reverse()), new Map([...configs].reverse()), generator)).toEqual(graph);
  const crlf = new Map<string, FileRecord>();
  for (const [p, r] of records)
    crlf.set(
      p,
      p.endsWith('.java')
        ? await record(p, '\ufeff' + (await readFile(join(root, p), 'utf8')).replaceAll('\n', '\r\n'))
        : r,
    );
  expect(buildGraph(crlf, configs, generator)).toEqual(graph);
});
it('does not pick an arbitrary wildcard type and retains malformed source as partial coverage', async () => {
  const records = new Map<string, FileRecord>();
  for (const [path, source] of [
    ['a/Foo.java', 'package a; public class Foo { public static void run(){} }'],
    ['b/Foo.java', 'package b; public class Foo { public static void run(){} }'],
    ['Main.java', 'import a.*; import b.*; public class Main { void run(){ Foo.run(); } }'],
  ])
    records.set(path!, await record(path!, source!));
  const graph = buildGraph(records, new Map(), generator);
  expect(graph.edges.filter((e) => e.rel === 'calls')).toEqual([]);
  expect(graph.unresolved.some((u) => u.target === 'Foo.run')).toBe(true);
  expect((await record('Broken.java', 'class Broken { void run( ')).file.status).toBe('syntax-errors');
  expect(() => buildGraph(records, new Map(), generator, 0, { files: 100, symbols: 100, edges: 10 })).toThrow('limit');
  const config = parseProjectConfig('settings.gradle.kts', 'include(":a", ":b")');
  expect(config).toMatchObject({ kind: 'java-project', data: { modules: ['a', 'b'] } });
  expect(
    JSON.stringify(await record('Safe.java', 'public class Safe { private String password = "PRIVATE_VALUE"; }')),
  ).not.toContain('PRIVATE_VALUE');
  expect(
    (await record('Outer.java', 'class Outer { void go(){ new Object(){ void hidden(){} }; } }')).symbols.map(
      (s) => s.name,
    ),
  ).not.toContain('hidden');
});
