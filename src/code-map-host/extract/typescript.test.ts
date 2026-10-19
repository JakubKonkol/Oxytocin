import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { extractTypeScript } from './typescript';
import { FileRecordSchema, type FileRecord } from './record';
import { fileRecord, normalizedSource } from './files';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from '../graph/build';
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
  const tree = await runtime.parse(
    source,
    path.endsWith('.tsx') ? 'tsx' : /\.[cm]?jsx?$/.test(path) ? 'javascript' : 'typescript',
  );
  try {
    return FileRecordSchema.parse(extractTypeScript(path, source, tree));
  } finally {
    tree.delete();
  }
}
const generator = {
  oxytocin: 'test',
  extractors: { files: 1, typescript: 1 },
  grammars: {},
  settingsHash: `sha256:${'0'.repeat(64)}`,
};

describe('TypeScript syntax and binding extraction', () => {
  it('resolves aliases, extension substitution, workspace exports and re-exports against a reviewed fixture', async () => {
    const root = resolve('tests/fixtures/code-map/modules');
    const records = new Map<string, FileRecord>(),
      configs = new Map<string, ProjectConfig>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else {
          const path = relative(root, absolute).split(sep).join('/');
          if (path === 'expected.json' || path === 'MAP.expected.md') continue;
          const source = await readFile(absolute, 'utf8');
          records.set(path, path.endsWith('.ts') ? await extract(path, source) : fileRecord(path, source));
          const config = parseProjectConfig(path, source);
          if (config) configs.set(path, config);
        }
      }
    };
    await walk(root);
    const graph = buildGraph(records, configs, generator);
    const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
    const calls = graph.edges
      .filter((edge) => edge.rel === 'calls')
      .map((edge) => [
        symbols.get(edge.from)?.file.slice(2),
        symbols.get(edge.from)?.name,
        symbols.get(edge.to)?.file.slice(2),
        symbols.get(edge.to)?.name,
      ]);
    const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8')) as {
      imports: string[][];
      calls: string[][];
      shadowedCaller: string;
    };
    const imports = graph.edges
      .filter((edge) => edge.rel === 'imports')
      .map((edge) => [edge.from.slice(2), edge.to.slice(2)]);
    expect(imports).toHaveLength(expected.imports.length);
    expect(imports).toEqual(expect.arrayContaining(expected.imports));
    expect(calls).toHaveLength(expected.calls.length);
    for (const pair of expected.calls) expect(calls).toContainEqual(pair);
    expect(calls.some(([, from]) => from === expected.shadowedCaller)).toBe(false);
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ target: 'compute', reason: 'unknown-value-type' }),
    );
    expect(JSON.stringify(buildGraph(new Map([...records].reverse()), configs, generator))).toBe(JSON.stringify(graph));
    await expect(renderMapMarkdown(graph, configs)).toMatchFileSnapshot(join(root, 'MAP.expected.md'));
  });
  it('keeps UTF-16 positions and stable IDs across BOM, CRLF, comments and Unicode', async () => {
    const source =
      "const city = '\u{1f30d}'; export function run(value: string = 'PRIVATE_VALUE'): string { return value; }\n";
    const normal = await extract('a.ts', source),
      windows = await extract('a.ts', `\ufeff${source.replace(/\n/g, '\r\n')}`);
    expect(windows).toEqual(normal);
    const run = normal.symbols.find((symbol) => symbol.name === 'run')!;
    expect(run.span[1]).toBe(source.indexOf('function'));
    expect(run.signature).not.toContain('PRIVATE_VALUE');
    const shifted = await extract('a.ts', `// comment\n${source}`);
    expect(shifted.symbols.map((symbol) => symbol.id)).toEqual(normal.symbols.map((symbol) => symbol.id));
  });
  it('tracks instance/static methods and leaves unknown receiver calls unresolved', async () => {
    const record = await extract(
      'a.ts',
      'export class A { first() {} second() { this.first(); } static make() { return new A(); } } export function run(unknown: any) { A.make(); unknown.first(); }',
    );
    const graph = buildGraph(new Map([['a.ts', record]]), new Map(), generator);
    const byId = new Map(graph.symbols.map((symbol) => [symbol.id, symbol.name]));
    expect(
      graph.edges.filter((edge) => edge.rel === 'calls').map((edge) => [byId.get(edge.from), byId.get(edge.to)]),
    ).toEqual(
      expect.arrayContaining([
        ['second', 'first'],
        ['make', 'A'],
        ['run', 'make'],
      ]),
    );
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ target: 'unknown.first', reason: 'unknown-value-type' }),
    );
  });
  it('resolves method overloads to their implementation and preserves type-only namespace imports', async () => {
    const records = new Map<string, FileRecord>();
    records.set(
      'a.ts',
      await extract(
        'a.ts',
        'export class A { method(value: string): void; method(value: number): void; method(value: unknown) {} run() { this.method(1); } }',
      ),
    );
    records.set(
      'b.ts',
      await extract('b.ts', "import type * as types from './a'; export function run() { new types.A(); }"),
    );
    const graph = buildGraph(records, new Map(), generator);
    expect(graph.edges.filter((edge) => edge.rel === 'calls')).toHaveLength(1);
    expect(graph.unresolved).toContainEqual(expect.objectContaining({ target: 'types.A', reason: 'type-only-import' }));
  });
  it('retains explicit local export aliases in public APIs and binds callers to the original declaration', async () => {
    const records = new Map<string, FileRecord>();
    records.set('a.ts', await extract('a.ts', 'function local() {} export {local as exposed};'));
    records.set('b.ts', await extract('b.ts', "import {exposed} from './a'; export function run() { exposed(); }"));
    const graph = buildGraph(records, new Map(), generator),
      local = graph.symbols.find((symbol) => symbol.name === 'local')!;
    expect(local.exported).toBe(true);
    expect(graph.edges).toContainEqual(expect.objectContaining({ to: local.id, rel: 'calls' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'f:a.ts', to: local.id, rel: 'exports' }));
  });
  it('exposes public members of a locally exported class while retaining private visibility', async () => {
    const record = await extract(
      'a.ts',
      'class A { public run() {} private hidden() {} private value = 1; } export {A};',
    );
    const graph = buildGraph(new Map([['a.ts', record]]), new Map(), generator);
    expect(
      graph.symbols
        .filter((symbol) => symbol.exported)
        .map((symbol) => symbol.name)
        .sort(),
    ).toEqual(['A', 'run']);
  });
  it('does not expose methods of a private object literal as module exports', async () => {
    const record = await extract('a.ts', 'const privateObject = { hidden() {} }; export function run() {}');
    expect(record.symbols.find((symbol) => symbol.name === 'hidden')?.exported).toBe(false);
  });
  it('handles cycles, literal require/import and JSX while retaining diagnostics for parser recovery', async () => {
    const records = new Map<string, FileRecord>();
    for (const [path, source] of [
      ['a.ts', "export * from './b'; export function stable() {}"],
      ['b.ts', "export * from './a';"],
      [
        'main.tsx',
        "import {stable} from './b'; const mod = require('./a'); export const Component = () => <div>Plan & implement</div>; export function run() { stable(); mod.stable(); import('./a'); import(path); }",
      ],
    ])
      records.set(path!, await extract(path!, source!));
    const graph = buildGraph(records, new Map(), generator);
    expect(graph.edges.filter((edge) => edge.rel === 'calls' && edge.to.includes('function:stable'))).toHaveLength(2);
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ target: '<dynamic>', reason: 'dynamic-module-specifier' }),
    );
    expect(
      records.get('main.tsx')!.symbols.some((symbol) => symbol.name === 'Component' && symbol.kind === 'component'),
    ).toBe(true);
    expect(records.get('main.tsx')!.file.status).toBe('syntax-errors');
  });
  it('enforces graph limits and the Markdown byte budget without source bodies', async () => {
    const record = await extract('a.ts', "export function run() { const secret = 'PRIVATE_BODY'; return secret; }");
    const records = new Map([['a.ts', record]]);
    expect(() => buildGraph(records, new Map(), generator, 0, { files: 1, symbols: 0, edges: 10 })).toThrow(
      'limit reached',
    );
    const graph = buildGraph(records, new Map(), generator);
    const markdown = renderMapMarkdown(graph, new Map(), 800);
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(800);
    expect(markdown).not.toContain('PRIVATE_BODY');
    expect(markdown).not.toContain(assets);
    expect(renderMapMarkdown(graph)).toBe(renderMapMarkdown(graph));
  });
});
