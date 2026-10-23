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
    expect(CodeMapGraphSchema.parse(graph)).toEqual(graph);
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

/** Declared-type receiver resolution: `x.m()`, `this.x.m()` and `this.x.y.m()` through indexed types. */
describe('TypeScript declared-type receivers', () => {
  async function analyze(files: Record<string, string>) {
    const records = new Map<string, FileRecord>();
    for (const [path, source] of Object.entries(files)) records.set(path, await extract(path, source));
    const graph = buildGraph(records, new Map(), generator);
    const byId = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
    const label = (id: string) => {
      const symbol = byId.get(id);
      const owner = symbol?.owner ? byId.get(symbol.owner) : undefined;
      return symbol ? (owner ? `${owner.name}.${symbol.name}` : symbol.name) : id;
    };
    return {
      graph,
      calls: graph.edges
        .filter((edge) => edge.rel === 'calls')
        .map((edge) => `${label(edge.from)} -> ${label(edge.to)}`),
      references: graph.edges
        .filter((edge) => edge.rel === 'references')
        .map((edge) => `${label(edge.from)} -> ${label(edge.to)}`),
      reasons: (target: string) =>
        graph.unresolved
          .filter((entry) => entry.target === target && entry.rel === 'calls')
          .map((entry) => entry.reason),
    };
  }
  it('resolves constructor parameter properties, class fields and nested object-literal member types', async () => {
    const { calls, references } = await analyze({
      'a.ts': `
        export class Service { query() {} get() {} }
        export class Settings { getSettings() {} }
        export interface Logger { warn(message: string): void }
        type Deps = { service: Service; logger: Logger };
        export class Host {
          private readonly cache = new Service();
          private inline: { service: Service; nested: { logger: Logger } };
          constructor(private readonly settings: Settings, private readonly deps: Deps, public logger?: Logger, readonly options?: { service: Service }) {}
          run() {
            this.settings.getSettings();
            this.deps.service.query();
            this.deps.logger.warn('x');
            this.cache.get();
            this.inline.service.query();
            this.options?.service.query();
            this.inline.nested.logger.warn('y');
            this.logger?.warn('z');
            this.consume(this.deps.service);
          }
          consume(value: Service) {}
        }`,
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        'Host.run -> Settings.getSettings',
        'Host.run -> Service.query',
        'Host.run -> Logger.warn',
        'Host.run -> Service.get',
      ]),
    );
    expect(calls.filter((call) => call === 'Host.run -> Service.query')).toHaveLength(3);
    expect(calls.filter((call) => call === 'Host.run -> Logger.warn')).toHaveLength(3);
    expect(references).toContain('Host.run -> Deps.service');
  });
  it('resolves parameters, annotated and new-initialized variables, including unions with null and undefined', async () => {
    const { calls } = await analyze({
      'store.ts': 'export class JsonFileStore { read() {} write() {} }',
      'use.ts': `
        import { JsonFileStore } from './store';
        import * as ns from './store';
        export function f(store: JsonFileStore, maybe?: JsonFileStore, other: ns.JsonFileStore | null = null) {
          store.read();
          maybe?.write();
          other?.read();
          const annotated: JsonFileStore = store;
          annotated.write();
          const created = new JsonFileStore();
          created.read();
          let later: JsonFileStore | undefined;
          later?.write();
          const cast = (store as JsonFileStore | undefined)!;
          cast.read();
          const viaNs = new ns.JsonFileStore();
          viaNs.write();
        }`,
    });
    expect(calls.filter((call) => call === 'f -> JsonFileStore.read')).toHaveLength(4);
    expect(calls.filter((call) => call === 'f -> JsonFileStore.write')).toHaveLength(4);
  });
  it('resolves exported variables through their declared type across files', async () => {
    const { calls } = await analyze({
      'a.ts':
        'export class Store { read() {} } export const store: Store = new Store(); export const other = new Store();',
      'b.ts': "import { store, other } from './a'; export function f() { store.read(); other.read(); }",
    });
    expect(calls.filter((call) => call === 'f -> Store.read')).toHaveLength(2);
  });
  it('follows return type annotations of resolved functions and methods, and unwraps Promise only after await', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        export class Repo { find() {} }
        export class Factory { create(): Repo { return new Repo(); } async load(): Promise<Repo> { return new Repo(); } }
        export function make(): Repo { return new Repo(); }
        export async function load(): Promise<Repo> { return new Repo(); }
        export function maybe(): Repo | undefined { return undefined; }
        export function run(factory: Factory) {
          const a = make();
          a.find();
          const b = factory.create();
          b.find();
        }
        export async function runAsync(factory: Factory) {
          const c = await load();
          c.find();
          const d = await factory.load();
          d.find();
          const pending = load();
          pending.find();
          const e = maybe();
          e?.find();
        }`,
    });
    expect(calls.filter((call) => call === 'run -> Repo.find')).toHaveLength(2);
    expect(calls.filter((call) => call === 'runAsync -> Repo.find')).toHaveLength(3);
    expect(reasons('pending.find')).toEqual(['unknown-value-type']);
  });
  it('resolves inherited members through extends and implements, preferring the nearest declaration', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        export interface Named { name(): string }
        export interface Closable extends Named { close(): void }
        export class Base { shared() {} overridden() {} }
        export class Mid extends Base { overridden() {} }
        export class Leaf extends Mid { own() {} }
        export abstract class Abstract implements Closable { abstract close(): void }
        export class External extends Unknown { local() {} }
        export function f(leaf: Leaf, closable: Closable, abs: Abstract, external: External) {
          leaf.shared();
          leaf.overridden();
          leaf.own();
          closable.name();
          abs.name();
          external.local();
          external.fromUnknown();
        }`,
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        'f -> Base.shared',
        'f -> Mid.overridden',
        'f -> Leaf.own',
        'f -> Named.name',
        'f -> External.local',
      ]),
    );
    expect(calls).not.toContain('f -> Base.overridden');
    expect(calls.filter((call) => call === 'f -> Named.name')).toHaveLength(2);
    expect(reasons('external.fromUnknown')).toEqual(['member-not-resolved']);
  });
  it('resolves through type aliases and survives cyclic aliases and recursive types', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        class Service { query() {} }
        type Alias = Service;
        type Again = Alias;
        type Loop1 = Loop2;
        type Loop2 = Loop1;
        interface Node { next: Node; touch(): void }
        export function f(a: Again, loop: Loop1, node: Node) {
          a.query();
          loop.query();
          node.next.next.touch();
        }`,
    });
    expect(calls.filter((call) => call === 'f -> Service.query')).toHaveLength(1);
    expect(calls).toContain('f -> Node.touch');
    expect(reasons('loop.query')).toEqual(['unknown-value-type']);
  });
  it('terminates on cyclic or self-referential inheritance without resolving anything through it', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        class A extends B { own() {} }
        class B extends A {}
        class C extends C.Inner {}
        export function f(a: A, c: C) {
          a.own();
          a.missing();
          c.missing();
        }`,
    });
    expect(calls).toEqual(['f -> A.own']);
    expect(reasons('a.missing')).toEqual(['member-not-resolved']);
    expect(reasons('c.missing')).toEqual(['member-not-resolved']);
  });
  it('keeps same-named methods of unrelated classes apart', async () => {
    const { calls } = await analyze({
      'a.ts': `
        class A { run() {} }
        class B { run() {} }
        export function f(a: A, b: B) { a.run(); b.run(); }`,
    });
    expect(calls.filter((call) => call.startsWith('f ->')).sort()).toEqual(['f -> A.run', 'f -> B.run']);
  });
  it('never resolves unions, any, unknown, arrays, generics, type parameters or unindexed types', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        class A { run() {} }
        class B { run() {} }
        export function f<T extends A>(
          either: A | B, loose: any, opaque: unknown, list: A[], boxed: Promise<A>, typed: T, lib: Map<string, A>,
          external: Unknown, fn: () => A, both: A & B,
        ) {
          either.run(); loose.run(); opaque.run(); list.run(); boxed.run(); typed.run(); lib.run(); external.run();
          fn.run(); both.run();
        }`,
    });
    expect(calls).toEqual([]);
    for (const target of [
      'either.run',
      'loose.run',
      'opaque.run',
      'list.run',
      'boxed.run',
      'typed.run',
      'lib.run',
      'both.run',
    ])
      expect(reasons(target)).toEqual(['unknown-value-type']);
  });
  it('lets the nearest binding win: shadowing parameters, loop variables, catch clauses and switch cases', async () => {
    const { calls } = await analyze({
      'a.ts': `
        class A { run() {} }
        class B { run() {} }
        export function f(item: A, items: B[], other: unknown) {
          const nested = (item) => item.run();
          for (const item of items) item.run();
          try { other; } catch (item) { item.run(); }
          switch (items.length) { case 1: { const item = items[0]; item.run(); } }
          function inner(item: B) { item.run(); }
          item.run();
        }`,
    });
    expect(calls.filter((call) => call.startsWith('f ->'))).toEqual(['f -> A.run']);
    expect(calls).toContain('f.inner -> B.run');
  });
  it('drops return types of overloaded declarations and ignores computed access', async () => {
    const { calls } = await analyze({
      'a.ts': `
        class A { run() {} }
        class B { run() {} }
        function pick(kind: 'a'): A;
        function pick(kind: 'b'): B;
        function pick(kind: string): A | B { return new A(); }
        class Holder { private a = new A(); get(key: string) { this[key].run(); this['a'].run(); } }
        export function f() { const x = pick('a'); x.run(); }`,
    });
    expect(calls.filter((call) => call.endsWith('.run'))).toEqual([]);
  });
  it('does not treat this inside an object-literal method as the enclosing class', async () => {
    const { calls } = await analyze({
      'a.ts': `
        class Service { query() {} }
        export class Host {
          private service = new Service();
          make() { return { run() { this.service.query(); } }; }
        }`,
    });
    expect(calls.filter((call) => call.endsWith('.query'))).toEqual([]);
  });
  it('follows aliases and object destructuring of typed values, but not renamed or computed sources', async () => {
    const { calls, reasons } = await analyze({
      'a.ts': `
        class Service { query() {} }
        class Logger { warn() {} }
        class Other { query() {} warn() {} }
        interface Deps { service: Service; logger: Logger }
        export class Host {
          constructor(private readonly deps: Deps, private readonly service: Service) {}
          run(param: Service) {
            const { service, logger: log } = this.deps;
            service.query();
            log.warn();
            const alias = this.service;
            alias.query();
            const again = param;
            again.query();
            const [first] = [param];
            first.query();
            const { missing } = this.deps;
            missing.query();
            const { service: Other } = this.deps;
            const dynamic = this.deps[param.toString()];
            dynamic.query();
          }
        }`,
    });
    expect(calls.filter((call) => call === 'Host.run -> Service.query')).toHaveLength(3);
    expect(calls.filter((call) => call === 'Host.run -> Logger.warn')).toHaveLength(1);
    expect(reasons('first.query')).toEqual(['unknown-value-type']);
    expect(reasons('missing.query')).toEqual(['unknown-value-type']);
    expect(reasons('dynamic.query')).toEqual(['unknown-value-type']);
  });
  it('unwraps member-preserving utility types unless the project declares a type of that name', async () => {
    const { calls } = await analyze({
      'a.ts': `
        class Service { query() {} close() {} }
        type Narrow = Pick<Service, 'query'>;
        export function f(a: Pick<Service, 'query'>, b: Readonly<Narrow>, c: Partial<Service> | undefined) {
          a.query();
          b.query();
          c?.close();
        }`,
      'b.ts': `
        class Service { query() {} }
        class Mine { other() {} }
        type Pick<T, K> = Mine;
        export function g(a: Pick<Service, 'query'>) { a.query(); }`,
    });
    expect(calls.filter((call) => call.startsWith('f ->')).sort()).toEqual([
      'f -> Service.close',
      'f -> Service.query',
      'f -> Service.query',
    ]);
    expect(calls.filter((call) => call.startsWith('g ->'))).toEqual([]);
  });
  it('infers types from initializers in TypeScript but only from const initializers in JavaScript', async () => {
    const source = `
      class A { run() {} }
      class B { run() {} }
      export function f() {
        const a = new A();
        let b = new B();
        a.run();
        b.run();
      }`;
    const ts = await analyze({ 'a.ts': source });
    expect(ts.calls.filter((call) => call.endsWith('.run')).sort()).toEqual(['f -> A.run', 'f -> B.run']);
    const js = await analyze({ 'a.js': source });
    expect(js.calls.filter((call) => call.endsWith('.run'))).toEqual(['f -> A.run']);
  });
});
