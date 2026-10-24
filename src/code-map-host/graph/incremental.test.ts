import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { extractTypeScript } from '../extract/typescript';
import { buildSearchData } from '../extract/search-data';
import { normalizedSource } from '../extract/files';
import type { FileRecord } from '../extract/record';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { buildGraph } from './build';
import { ResolutionCache } from './resolution-cache';

let assets: string;
let parser: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-incremental-assets-'));
  await copyCodeMapAssets(assets);
  parser = new ParserRuntime(assets);
});
afterAll(async () => {
  parser?.dispose();
  if (assets) await rm(assets, { recursive: true, force: true });
});

async function extract(path: string, source: string): Promise<FileRecord> {
  const text = normalizedSource(source);
  const tree = await parser.parse(text, path.endsWith('.tsx') ? 'tsx' : 'typescript');
  try {
    const record = extractTypeScript(path, text, tree);
    record.search = buildSearchData(text, record.symbols);
    return record;
  } finally {
    tree.delete();
  }
}
const generator = {
  oxytocin: 'test',
  extractors: {},
  grammars: {},
  settingsHash: `sha256:${'0'.repeat(64)}`,
} as Parameters<typeof buildGraph>[2];

/** A project whose records change step by step; every step must give the same graph with and without the cache. */
class Project {
  readonly records = new Map<string, FileRecord>();
  readonly configs = new Map<string, ProjectConfig>();
  readonly cache = new ResolutionCache();
  async set(path: string, source: string): Promise<void> {
    const config = parseProjectConfig(path, source);
    if (config) this.configs.set(path, config);
    this.records.set(path, await extract(path, source));
  }
  delete(path: string): void {
    this.records.delete(path);
    this.configs.delete(path);
  }
  /** Builds incrementally and from scratch; returns the serialized graph after asserting both are byte-identical. */
  check(): string {
    const incremental = JSON.stringify(buildGraph(this.records, this.configs, generator, 0, undefined, this.cache));
    const full = JSON.stringify(buildGraph(this.records, this.configs, generator, 0));
    expect(incremental === full).toBe(true);
    return incremental;
  }
}

const base: Record<string, string> = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"] } } }',
  'package.json': '{ "name": "demo" }',
  'src/lib/shape.ts':
    'export interface Shape { area(): number }\nexport class Base { describe(): string { return "b"; } }\n',
  'src/lib/square.ts':
    'import { Shape, Base } from "./shape";\nexport class Square extends Base implements Shape { area(): number { return 4; } }\nexport const unit = new Square();\n',
  'src/lib/index.ts': 'export * from "./shape";\nexport { Square as Box } from "./square";\n',
  'src/app/main.ts':
    'import { Box, Shape } from "@lib/index";\nimport { helper } from "../util";\nexport function run(s: Shape, box: Box): number {\n  helper();\n  box.describe();\n  return s.area() + box.area();\n}\n',
  'src/util.ts': 'export function helper(): void {}\nexport function other(): void { helper(); }\n',
  'src/consumer.ts': 'import { other } from "./util";\nexport function consume() { other(); }\n',
};

describe('incremental relation resolution', () => {
  it('equals a full build after every kind of edit', async () => {
    const project = new Project();
    for (const [path, source] of Object.entries(base)) await project.set(path, source);
    project.check();
    // Body edit that keeps every export: only the file itself changes.
    await project.set('src/consumer.ts', `${base['src/consumer.ts']!}// note\nexport function again() { other(); }\n`);
    project.check();
    // A new export in a dependency, then its use.
    await project.set('src/util.ts', `${base['src/util.ts']!}export function extra(): void {}\n`);
    project.check();
    await project.set(
      'src/consumer.ts',
      'import { other, extra } from "./util";\nexport function consume() { other(); extra(); }\n',
    );
    project.check();
    // Renaming an export breaks its importers; the reverse repairs them.
    await project.set(
      'src/util.ts',
      'export function helper2(): void {}\nexport function other(): void { helper2(); }\n',
    );
    project.check();
    await project.set('src/util.ts', base['src/util.ts']!);
    project.check();
    // A re-exported class changes a member that a caller resolves through two modules.
    await project.set(
      'src/lib/shape.ts',
      'export interface Shape { area(): number }\nexport class Base { describe2(): string { return "b"; } }\n',
    );
    project.check();
    await project.set('src/lib/shape.ts', base['src/lib/shape.ts']!);
    project.check();
    // A wildcard re-export makes two modules answer the same name; undoing it repairs the importer.
    await project.set('src/lib/index.ts', `${base['src/lib/index.ts']!}export * from "../util";\n`);
    await project.set('src/util.ts', `${base['src/util.ts']!}export interface Shape { x: number }\n`);
    project.check();
    await project.set('src/util.ts', base['src/util.ts']!);
    project.check();
    await project.set('src/lib/index.ts', base['src/lib/index.ts']!);
    project.check();
    // An unrelated export is added to a barrel that importers go through.
    await project.set('src/lib/shape.ts', `${base['src/lib/shape.ts']!}export const extra = 1;\n`);
    project.check();
    await project.set('src/lib/shape.ts', base['src/lib/shape.ts']!);
    project.check();
    // Removing and adding files changes module lookups (candidate paths) and path mappings.
    project.delete('src/lib/square.ts');
    project.check();
    await project.set('src/lib/square.ts', base['src/lib/square.ts']!);
    project.check();
    await project.set('src/util/index.ts', 'export function helper(): void {}\n');
    project.check();
    project.delete('src/util/index.ts');
    project.check();
    // Configuration changes invalidate everything.
    await project.set('tsconfig.json', '{ "compilerOptions": { "paths": { "@lib/*": ["./src/other/*"] } } }');
    project.check();
    await project.set('tsconfig.json', base['tsconfig.json']!);
    project.check();
  });

  it('resolves only the files whose inputs changed', async () => {
    const project = new Project();
    for (const [path, source] of Object.entries(base)) await project.set(path, source);
    const counted = (): number => {
      let resolved = 0;
      const original = project.cache.store.bind(project.cache);
      project.cache.store = (...args) => {
        resolved++;
        return original(...args);
      };
      buildGraph(project.records, project.configs, generator, 0, undefined, project.cache);
      project.cache.store = original;
      return resolved;
    };
    expect(counted()).toBe(project.records.size);
    expect(counted()).toBe(0);
    await project.set('src/app/main.ts', `${base['src/app/main.ts']!}\nexport const more = 1;\n`);
    expect(counted()).toBe(1);
    // Adding an export nobody imports changes no facet that importers read: only the edited file resolves again.
    await project.set('src/util.ts', `${base['src/util.ts']!}\nexport const more = 1;\n`);
    expect(counted()).toBe(1);
    // Moving code (positions only) changes nothing importers read either.
    await project.set('src/util.ts', `\n\n${base['src/util.ts']!}\nexport const more = 1;\n`);
    expect(counted()).toBe(1);
    // Renaming an export that `consumer.ts` imports makes it resolve again, but not the unrelated files.
    await project.set(
      'src/util.ts',
      'export function helper(): void {}\nexport function renamed(): void { helper(); }\nexport const more = 1;\n',
    );
    expect(counted()).toBe(2);
  });

  it('equals a full build on a real code base under a sequence of edits', async () => {
    const repo = resolve(import.meta.dirname, '../../..');
    const roots = ['src/code-map-host/query', 'src/code-map-host/resolve', 'src/shared/utils', 'src/shared/domain'];
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(repo, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (/\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    for (const root of roots) await walk(root);
    const project = new Project();
    for (const path of ['tsconfig.json', 'tsconfig.base.json', 'tsconfig.node.json', 'package.json'])
      await project.set(path, await readFile(join(repo, path), 'utf8'));
    const sources = new Map<string, string>();
    for (const path of files) {
      const source = await readFile(join(repo, path), 'utf8');
      sources.set(path, source);
      await project.set(path, source);
    }
    project.check();
    const hub = 'src/shared/utils/disposable.ts';
    const sample = [
      hub,
      'src/code-map-host/query/terms.ts',
      'src/code-map-host/query/search.ts',
      'src/shared/domain/code-map.ts',
    ];
    for (const path of sample) {
      const source = sources.get(path);
      if (!source) continue;
      await project.set(path, `${source}\nexport function zqEdited(): number { return 1; }\n`);
      project.check();
      await project.set(path, source.replace(/export function (\w+)/, 'export function renamed_$1'));
      project.check();
      project.delete(path);
      project.check();
      await project.set(path, source);
      project.check();
    }
  }, 120_000);
});
