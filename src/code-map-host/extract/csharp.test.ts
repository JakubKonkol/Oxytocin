import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeMapGraph } from '@shared/domain/code-map';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { makeCodeMapCSharpFixture } from '../../../scripts/make-fixtures';
import { ParserRuntime } from '../parse/runtime';
import { extractCSharp } from './csharp';
import { FileRecordSchema, type FileRecord } from './record';
import { fileRecord, normalizedSource } from './files';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from '../graph/build';
import { CodeMapGraphSchema } from '@shared/domain/code-map';
import { renderMapMarkdown } from '../map-md';

let assets: string;
let runtime: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-grammar-test-'));
  await copyCodeMapAssets(assets);
  runtime = new ParserRuntime(assets);
});
afterAll(async () => {
  runtime?.dispose();
  if (assets) await rm(assets, { recursive: true, force: true });
});
async function extract(path: string, input: string) {
  const source = normalizedSource(input);
  const tree = await runtime.parse(source, 'csharp');
  try {
    return FileRecordSchema.parse(extractCSharp(path, source, tree));
  } finally {
    tree.delete();
  }
}
const generator = {
  oxytocin: 'test',
  extractors: { csharp: 3, files: 1, typescript: 3 },
  grammars: {},
  settingsHash: `sha256:${'0'.repeat(64)}`,
};
const BOM = String.fromCharCode(0xfeff);
const fixture = resolve('tests/fixtures/code-map/csharp-solution');
async function load(root: string, transform = (source: string) => source) {
  const records = new Map<string, FileRecord>(),
    configs = new Map<string, ProjectConfig>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const path = relative(root, absolute).split(sep).join('/');
        if (path === 'expected.json' || path === 'MAP.expected.md') continue;
        const source = transform(await readFile(absolute, 'utf8'));
        records.set(path, path.endsWith('.cs') ? await extract(path, source) : fileRecord(path, source));
        const config = parseProjectConfig(path, source);
        if (config) configs.set(path, config);
      }
    }
  };
  await walk(root);
  return { records, configs };
}
async function graphOf(files: Record<string, string>): Promise<CodeMapGraph> {
  const records = new Map<string, FileRecord>(),
    configs = new Map<string, ProjectConfig>();
  for (const [path, source] of Object.entries(files)) {
    records.set(path, path.endsWith('.cs') ? await extract(path, source) : fileRecord(path, source));
    const config = parseProjectConfig(path, source);
    if (config) configs.set(path, config);
  }
  return buildGraph(records, configs, generator);
}
function calls(graph: CodeMapGraph, rel = 'calls') {
  const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
  return graph.edges
    .filter((edge) => edge.rel === rel)
    .map((edge) => [symbols.get(edge.from)?.name ?? edge.from, symbols.get(edge.to)?.name ?? edge.to, edge.prov]);
}

describe('C# extraction and binding', () => {
  it('matches the reviewed solution fixture: projects, partial types, namespaces and declared-type calls', async () => {
    const { records, configs } = await load(fixture);
    const graph = buildGraph(records, configs, generator);
    expect(CodeMapGraphSchema.parse(graph)).toEqual(graph);
    const expected = JSON.parse(await readFile(join(fixture, 'expected.json'), 'utf8')) as {
      calls: string[][];
      inheritance: string[][];
      unresolvedCalls: string[][];
    };
    const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
    const actual = graph.edges
      .filter((edge) => edge.rel === 'calls')
      .map((edge) => [
        edge.from.startsWith('f:') ? edge.from.slice(2) : symbols.get(edge.from)!.file.slice(2),
        edge.from.startsWith('f:') ? '<file>' : symbols.get(edge.from)!.name,
        symbols.get(edge.to)!.file.slice(2),
        symbols.get(edge.to)!.name,
        edge.prov,
      ]);
    expect(actual.sort()).toEqual([...expected.calls].sort());
    for (const [from, rel, to] of expected.inheritance) expect(calls(graph, rel)).toContainEqual([from, to, 'binding']);
    expect(graph.edges.filter((edge) => ['extends', 'implements'].includes(edge.rel))).toHaveLength(
      expected.inheritance.length,
    );
    expect(
      graph.unresolved.filter((entry) => entry.rel === 'calls').map((entry) => [entry.target, entry.reason]),
    ).toEqual(expect.arrayContaining(expected.unresolvedCalls));
    expect(graph.unresolved.filter((entry) => entry.rel === 'calls')).toHaveLength(expected.unresolvedCalls.length);
    const order = graph.symbols.filter((symbol) => symbol.name === 'Order' && symbol.kind === 'class');
    expect(order).toHaveLength(1);
    expect(order[0]).toMatchObject({ visibility: 'public', exported: true });
    expect(order[0]!.parts).toEqual([{ file: 'f:src/Core/Models/Order.cs', span: [3, 0, 12, 1] }]);
    expect(graph.symbols.find((symbol) => symbol.name === 'Write')).toMatchObject({ exported: false });
    expect(graph.groups.filter((group) => group.kind).map((group) => [group.id, group.kind, group.files])).toEqual([
      ['c:Contoso.sln', 'solution', 13],
      ['c:src/App/App.csproj', 'project', 4],
      ['c:src/Core/Core.csproj', 'project', 7],
      ['c:tests/Core.Tests/Core.Tests.csproj', 'project', 2],
    ]);
    expect(graph.edges).toContainEqual({
      from: 'c:src/App/App.csproj',
      to: 'c:src/Core/Core.csproj',
      rel: 'imports',
      prov: 'binding',
    });
    expect(graph.packages.map((entry) => entry.id)).toEqual(['p:nuget:Newtonsoft.Json', 'p:nuget:xunit']);
    expect(graph.files.find((file) => file.path === 'tests/Core.Tests/OrderTests.cs')?.test).toBe(true);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'f:src/Core/Services/OrderRepository.cs',
        to: 'f:src/Core/Services/RepositoryBase.cs',
        rel: 'references',
      }),
    );
    expect(JSON.stringify(buildGraph(new Map([...records].reverse()), configs, generator))).toBe(JSON.stringify(graph));
    const crlf = await load(fixture, (source) => `${BOM}${source.replace(/\n/g, '\r\n')}`);
    expect(JSON.stringify(buildGraph(crlf.records, crlf.configs, generator))).toBe(JSON.stringify(graph));
    const markdown = renderMapMarkdown(graph, configs);
    expect(markdown).not.toContain('Comments are never copied');
    await expect(markdown).toMatchFileSnapshot(join(fixture, 'MAP.expected.md'));
  });
  it('binds every call of the generated multi-project fixture across project references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-csharp-fixture-'));
    try {
      await makeCodeMapCSharpFixture(root, 1001);
      const { records, configs } = await load(root);
      const graph = buildGraph(records, configs, generator);
      expect(graph.unresolved.filter((entry) => entry.rel === 'calls')).toEqual([]);
      expect(graph.edges.filter((edge) => edge.rel === 'implements')).toHaveLength(1001);
      expect(graph.symbols.filter((symbol) => symbol.parts?.length)).toHaveLength(1001);
      expect(graph.edges.filter((edge) => edge.rel === 'imports' && edge.from.startsWith('c:'))).toHaveLength(2);
      // Each service after the first calls its predecessor's Run across files (and projects at boundaries).
      const runs = graph.edges.filter((edge) => edge.rel === 'calls' && edge.to.endsWith('.method:Run(Input0)'));
      expect(runs).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('indexes enum members in every branch of #if directives', async () => {
    // The pinned grammar cannot recover a member that follows `#endif` after a trailing comma.
    const record = await extract('E.cs', 'enum E { A, C,\n#if X\n B,\n#elif Y\n D,\n#else\n F,\n#endif\n}\n');
    expect(
      record.symbols
        .filter((symbol) => symbol.kind === 'property')
        .map((symbol) => symbol.name)
        .sort(),
    ).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
  it('follows a project reference whose path differs from the project file only in case', async () => {
    const graph = await graphOf({
      'src/Core/Core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'src/Core/Repo.cs': 'namespace Core { public class Repo { public void Save() {} } }',
      'src/App/App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\core\\core.csproj" /></ItemGroup></Project>',
      'src/App/Program.cs': 'using Core; class Program { void Go(Repo repo) { repo.Save(); } }',
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: 'c:src/App/App.csproj', to: 'c:src/Core/Core.csproj', rel: 'imports' }),
    );
    expect(calls(graph)).toEqual([['Go', 'Save', 'binding']]);
    expect(graph.unresolved.filter((entry) => entry.from.startsWith('c:'))).toEqual([]);
  });
  it('resolves aliases, static imports, nested and generic types without guessing ambiguous names', async () => {
    const graph = await graphOf({
      'A.cs':
        'namespace One { public class Shared { public static void Run() {} } public class Box<T> { public class Inner {} } }',
      'B.cs': 'namespace Two { public class Shared { public static void Run() {} } public class Box { } }',
      'C.cs': [
        'using One;',
        'using Two;',
        'using Alias = One.Shared;',
        'using static Two.Shared;',
        'class Client<T> {',
        '  T value;',
        '  Box<int>.Inner nested;',
        '  Box plain;',
        '  void Go() { Alias.Run(); Run(); Shared.Run(); }',
        '}',
      ].join('\n'),
    });
    const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
    const target = (id: string) => `${symbols.get(id)!.file.slice(2)}:${symbols.get(id)!.name}`;
    expect(graph.edges.filter((edge) => edge.rel === 'calls').map((edge) => target(edge.to))).toEqual([
      'A.cs:Run',
      'B.cs:Run',
    ]);
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ target: 'Shared.Run', reason: 'ambiguous-type' }),
    );
    const references = graph.edges.filter((edge) => edge.rel === 'references' && edge.to.startsWith('s:'));
    expect(references.map((edge) => target(edge.to)).sort()).toEqual(['A.cs:Inner', 'B.cs:Box']);
    expect(graph.unresolved.some((entry) => entry.target === 'T')).toBe(false);
  });
  it('binds overloads by argument count only and decides inheritance from the target kind, not an I prefix', async () => {
    const graph = await graphOf({
      'A.cs': [
        'class IBase { public virtual void M(int a) {} }',
        'interface Visible { }',
        'class Derived : IBase, Visible {',
        '  void M(string a, int b = 0) {}',
        '  void M(params int[] values) {}',
        '  void Go() { M(1, 2); M(); base.M(1); this.M("x"); }',
        '}',
      ].join('\n'),
    });
    expect(calls(graph, 'extends')).toEqual([['Derived', 'IBase', 'binding']]);
    expect(calls(graph, 'implements')).toEqual([['Derived', 'Visible', 'binding']]);
    expect(calls(graph).filter(([from]) => from === 'Go')).toEqual(
      expect.arrayContaining([
        ['Go', 'M', 'heuristic'],
        ['Go', 'M', 'binding'],
      ]),
    );
    const go = graph.edges.filter((edge) => edge.rel === 'calls' && edge.from.endsWith('Go()'));
    expect(go.filter((edge) => edge.at?.[1] === 14)).toHaveLength(2);
    expect(go.find((edge) => edge.to.endsWith('M(int)'))?.prov).toBe('binding');
  });
  it('keeps UTF-16 positions, stable IDs and private bodies out of signatures', async () => {
    const source = 'class A { string City = "\u{1f30d}"; public void Run(string secret = "PRIVATE_VALUE") { } }\n';
    const normal = await extract('A.cs', source),
      windows = await extract('A.cs', `${BOM}${source.replace(/\n/g, '\r\n')}`);
    expect(windows).toEqual(normal);
    const run = normal.symbols.find((symbol) => symbol.name === 'Run')!;
    expect(run.span[1]).toBe(source.indexOf('public void'));
    expect(run.signature).not.toContain('PRIVATE_VALUE');
    expect(run.id).toBe('s:A.cs#class:A.method:Run(string)');
    const shifted = await extract('A.cs', `// comment\n${source}`);
    expect(shifted.symbols.map((symbol) => symbol.id)).toEqual(normal.symbols.map((symbol) => symbol.id));
    const cased = await graphOf({
      'A.cs':
        'class Order { public void Run() {} } class order { public void Run() {} } class C { void Go(Order o) { o.Run(); } }',
    });
    expect(cased.edges.filter((edge) => edge.rel === 'calls').map((edge) => edge.to)).toEqual([
      's:A.cs#class:Order.method:Run()',
    ]);
  });
  it('reports syntax errors and binds members through declared chains and var initializers', async () => {
    const graph = await graphOf({
      'A.cs': [
        'class Engine { public void Start() {} }',
        'class Car { public Engine Engine { get; } = new Engine(); }',
        'class Driver { Car car; void Go(Car other) { car.Engine.Start(); var local = new Car(); local.Engine.Start(); other.Engine.Start(); } }',
      ].join('\n'),
    });
    expect(calls(graph).filter(([, to]) => to === 'Start')).toHaveLength(3);
    const broken = await extract('B.cs', 'class B { void M( { }');
    expect(broken.file.status).toBe('syntax-errors');
    expect(broken.syntaxErrors).toBeGreaterThan(0);
  });
});
