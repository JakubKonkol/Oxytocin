import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { CodeMapGraph, CodeMapSymbol } from '@shared/domain/code-map';
import type { FileRecord, PythonRecord } from '../extract/record';
import type { ProjectConfig } from './config';
import { CodeMapLimitError, comparePaths } from '../enumerate';

const ConfigSchema = z.object({
  tool: z
    .object({
      setuptools: z
        .object({
          'package-dir': z.record(z.string(), z.string()).optional(),
          packages: z
            .union([
              z.array(z.string()),
              z.object({ find: z.object({ where: z.array(z.string()).optional() }).optional() }),
            ])
            .optional(),
        })
        .optional(),
      poetry: z
        .object({ packages: z.array(z.object({ include: z.string(), from: z.string().optional() })).optional() })
        .optional(),
    })
    .optional(),
});
export function parsePythonConfig(path: string, source: string): ProjectConfig | null {
  if (posix.basename(path) !== 'pyproject.toml') return null;
  const config = ConfigSchema.parse(parseToml(source)),
    roots: { path: string; prefix: string }[] = [];
  const directories = config.tool?.setuptools?.['package-dir'] ?? {};
  for (const [prefix, directory] of Object.entries(directories)) roots.push({ path: directory, prefix });
  const packages = config.tool?.setuptools?.packages;
  if (packages && !Array.isArray(packages))
    for (const directory of packages.find?.where ?? []) roots.push({ path: directory, prefix: '' });
  for (const pkg of config.tool?.poetry?.packages ?? [])
    roots.push({ path: pkg.from ?? (pkg.include.includes('/') ? posix.dirname(pkg.include) : '.'), prefix: '' });
  if (roots.length > 2000) throw new CodeMapLimitError('Too many Python source roots');
  return { kind: 'python-project', data: { roots } };
}
type Value = { kind: 'symbol'; id: string } | { kind: 'module'; name: string };
const unique = (values: Value[]) => [
  ...new Map(values.map((v) => [v.kind === 'symbol' ? v.id : `m:${v.name}`, v])).values(),
];
const under = (path: string, root: string) => root === '.' || path.startsWith(root + '/');

/** A lexical/import resolver. Unknown instance attributes, dynamic imports and mutated paths are never guessed. */
export class PythonResolver {
  private readonly modules = new Map<string, string[]>();
  private readonly prefixes = new Set<string>();
  private readonly primary = new Map<string, string>();
  private readonly symbols = new Map<string, CodeMapSymbol>();
  private readonly symbolPath = new Map<string, string>();
  private readonly bindings = new Map<string, PythonRecord['bindings']>();
  private readonly scopes = new Map<string, FileRecord['scopes'][number]>();
  private readonly members = new Map<string, string[]>();
  private readonly bases = new Map<string, { path: string; base: PythonRecord['bases'][number] }[]>();
  constructor(
    private readonly records: ReadonlyMap<string, FileRecord>,
    configs: ReadonlyMap<string, ProjectConfig>,
  ) {
    const roots = [
      { path: '.', prefix: '' },
      { path: 'src', prefix: '' },
    ];
    for (const [path, config] of configs)
      if (config.kind === 'python-project') {
        for (const root of [{ path: '.', prefix: '' }, { path: 'src', prefix: '' }, ...config.data.roots]) {
          const directory = posix.normalize(posix.join(posix.dirname(path), root.path.replaceAll('\\', '/')));
          if (
            directory !== '..' &&
            !directory.startsWith('../') &&
            !posix.isAbsolute(directory) &&
            !directory.includes(':')
          )
            roots.push({ path: directory, prefix: root.prefix });
        }
      }
    const ordered = [...new Map(roots.map((r) => [`${r.path}\0${r.prefix}`, r])).values()].sort(
      (a, b) => b.path.length - a.path.length || comparePaths(a.prefix, b.prefix),
    );
    for (const [path, record] of records) {
      if (!record.python) continue;
      for (const root of ordered)
        if (under(path, root.path)) {
          const rest = root.path === '.' ? path : path.slice(root.path.length + 1);
          const module = [
            root.prefix,
            rest
              .replace(/\.py$/, '')
              .replace(/(?:^|\/)__init__$/, '')
              .replaceAll('/', '.'),
          ]
            .filter(Boolean)
            .join('.');
          if (
            !module ||
            !module.split('.').every((p) => /^\p{ID_Start}\p{ID_Continue}*$/u.test(p) || /^_\p{ID_Continue}*$/u.test(p))
          )
            continue;
          const list = this.modules.get(module) ?? [];
          if (!list.includes(path)) list.push(path);
          this.modules.set(module, list);
          if (!this.primary.has(path)) this.primary.set(path, module);
          const parts = module.split('.');
          for (let i = 1; i <= parts.length; i++) this.prefixes.add(parts.slice(0, i).join('.'));
        }
      for (const symbol of record.symbols) {
        this.symbols.set(symbol.id, symbol);
        this.symbolPath.set(symbol.id, path);
      }
      for (const scope of record.scopes) this.scopes.set(`${path}\0${scope.id}`, scope);
      for (const binding of record.python.bindings) {
        const key = `${path}\0${binding.scope}\0${binding.name}`,
          list = this.bindings.get(key) ?? [];
        list.push(binding);
        this.bindings.set(key, list);
      }
      for (const d of record.python.definitions)
        if (d.ownerClass) {
          const key = `${d.ownerClass}\0${d.name}`,
            list = this.members.get(key) ?? [];
          list.push(d.symbol);
          this.members.set(key, list);
        }
      for (const base of record.python.bases) {
        const list = this.bases.get(base.symbol) ?? [];
        list.push({ path, base });
        this.bases.set(base.symbol, list);
      }
    }
    for (const files of this.modules.values()) files.sort(comparePaths);
  }
  private module(path: string, name: string, level: number): string | null {
    if (!level) return name;
    const own = this.primary.get(path);
    if (!own) return null;
    const parts = own.split('.');
    if (posix.basename(path) !== '__init__.py') parts.pop();
    if (level > parts.length) return null;
    return [...parts.slice(0, parts.length - level + 1), ...name.split('.').filter(Boolean)].join('.');
  }
  private lexical(path: string, scope: string, name: string): PythonRecord['bindings'] | undefined {
    let fromFunction = false;
    for (
      let current: string | null = scope;
      current;
      current = this.scopes.get(`${path}\0${current}`)?.parent ?? null
    ) {
      const entry = this.scopes.get(`${path}\0${current}`);
      if (entry?.kind === 'class' && fromFunction) continue;
      if (entry?.kind === 'function') fromFunction = true;
      const group = this.bindings.get(`${path}\0${current}\0${name}`);
      if (group) return group;
    }
    return undefined;
  }
  private imported(path: string, binding: PythonRecord['bindings'][number], seen: Set<string>): Value[] {
    const module = this.module(path, binding.module ?? '', binding.level ?? 0);
    if (!module) return [];
    return binding.imported ? this.exported(module, binding.imported, seen) : [{ kind: 'module', name: module }];
  }
  private exported(module: string, name: string, seen: Set<string>): Value[] {
    const key = `export:${module}.${name}`;
    if (seen.has(key) || seen.size >= 256) return [];
    const next = new Set(seen).add(key),
      files = this.modules.get(module) ?? [];
    if (files.length > 1) return [];
    const path = files[0];
    const values = path ? this.name(path, 'file', [name], next) : [];
    if (values.length) return values;
    return this.prefixes.has(`${module}.${name}`) ? [{ kind: 'module', name: `${module}.${name}` }] : [];
  }
  private attributes(value: Value, parts: string[], seen: Set<string>): Value[] {
    if (!parts.length) return [value];
    const [first, ...rest] = parts;
    const found =
      value.kind === 'module'
        ? this.exported(value.name, first!, seen)
        : this.symbols.get(value.id)?.kind === 'class'
          ? this.method(value.id, first!, new Set()).map((id) => ({ kind: 'symbol' as const, id }))
          : [];
    return unique(found.flatMap((v) => this.attributes(v, rest, seen)));
  }
  private name(path: string, scope: string, parts: string[], seen = new Set<string>()): Value[] {
    if (!parts.length || seen.size >= 256) return [];
    const key = `${path}\0${scope}\0${parts.join('.')}`;
    if (seen.has(key)) return [];
    const next = new Set(seen).add(key),
      group = this.lexical(path, scope, parts[0]!);
    let values: Value[] = [];
    if (group) {
      if (group.some((b) => b.kind === 'unknown')) return [];
      values = group.flatMap((b) =>
        b.kind === 'import'
          ? this.imported(path, b, next)
          : b.symbol
            ? [{ kind: 'symbol' as const, id: b.symbol }]
            : [],
      );
    } else {
      // A star import only exports a literal __all__, or public lexical bindings when __all__ is absent.
      for (const imported of this.records.get(path)!.python!.imports.filter((i) => i.wildcard && i.scope === 'file')) {
        const module = this.module(path, imported.module, imported.level),
          file = module ? this.modules.get(module) : undefined;
        if (file?.length !== 1) continue;
        const all = this.records.get(file[0]!)!.python!.all;
        if (all === null || (all ? !all.includes(parts[0]!) : parts[0]!.startsWith('_'))) continue;
        values.push(...this.exported(module!, parts[0]!, next));
      }
    }
    const roots = unique(values);
    if (roots.length !== 1) return [];
    return this.attributes(roots[0]!, parts.slice(1), next);
  }
  private method(owner: string, name: string, seen: Set<string>): string[] {
    if (seen.has(owner) || seen.size >= 64) return [];
    seen.add(owner);
    const own = this.members.get(`${owner}\0${name}`);
    if (own?.length) return [...new Set(own)];
    const found = (this.bases.get(owner) ?? []).flatMap(({ path, base }) =>
      (base.target ? this.name(path, base.scope, base.target) : []).flatMap((v) =>
        v.kind === 'symbol' && this.symbols.get(v.id)?.kind === 'class' ? this.method(v.id, name, new Set(seen)) : [],
      ),
    );
    return [...new Set(found)];
  }
  append(graph: CodeMapGraph, packages: Map<string, CodeMapGraph['packages'][number]>, limit: number) {
    const edge = (value: CodeMapGraph['edges'][number]) => {
      if (graph.edges.length >= limit) throw new CodeMapLimitError();
      graph.edges.push(value);
    };
    const unresolved = (value: CodeMapGraph['unresolved'][number]) => {
      if (graph.unresolved.length >= limit) throw new CodeMapLimitError();
      graph.unresolved.push(value);
    };
    for (const [path, record] of [...this.records].sort(([a], [b]) => comparePaths(a, b))) {
      if (!record.python) continue;
      for (const imported of record.python.imports) {
        const module = this.module(path, imported.module, imported.level),
          files = module ? (this.modules.get(module) ?? []) : [];
        const destinations = new Set(files);
        if (imported.from && module)
          for (const item of imported.names) {
            const values = this.exported(module, item.name, new Set());
            for (const value of values) {
              if (value.kind === 'symbol') {
                const target = this.symbolPath.get(value.id);
                if (target) destinations.add(target);
                if (
                  imported.scope === 'file' &&
                  (record.python.all
                    ? record.python.all.includes(item.alias)
                    : record.python.all !== null && !item.alias.startsWith('_'))
                )
                  edge({ from: record.file.id, to: value.id, rel: 'exports', prov: 'binding', at: imported.at });
              } else for (const p of this.modules.get(value.name) ?? []) destinations.add(p);
            }
          }
        if (destinations.size)
          for (const p of [...destinations].sort(comparePaths))
            edge({ from: record.file.id, to: `f:${p}`, rel: 'imports', prov: 'binding', at: imported.at });
        else if (module && this.prefixes.has(module)) {
          const id = `p:python:${module}`;
          packages.set(id, { id, name: module, external: false });
          edge({ from: record.file.id, to: id, rel: 'imports', prov: 'binding', at: imported.at });
        } else if (module && !imported.level) {
          const id = `p:python:${module}`;
          packages.set(id, { id, name: module, external: true });
          edge({ from: record.file.id, to: id, rel: 'imports', prov: 'syntax', at: imported.at });
        } else
          unresolved({
            from: record.file.id,
            rel: 'imports',
            target: '.'.repeat(imported.level) + imported.module,
            at: imported.at,
            reason: 'relative-module-not-indexed',
          });
      }
      for (const base of record.python.bases) {
        const values = base.target ? this.name(path, base.scope, base.target) : [];
        if (values.length === 1 && values[0]!.kind === 'symbol' && this.symbols.get(values[0]!.id)?.kind === 'class')
          edge({ from: base.symbol, to: values[0]!.id, rel: 'extends', prov: 'binding', at: base.at });
        else
          unresolved({
            from: base.symbol,
            rel: 'extends',
            target: base.target?.join('.') ?? '<expression>',
            at: base.at,
            reason: 'dynamic-external-or-ambiguous-base',
          });
      }
      for (const call of record.python.calls) {
        const values = call.target ? this.name(path, call.scope, call.target) : [];
        const found = values.length === 1 && values[0]!.kind === 'symbol' ? this.symbols.get(values[0]!.id) : undefined;
        if (
          found &&
          ['function', 'method', 'class'].includes(found.kind) &&
          !found.decorators?.some((d) => /^@(?:\w+\.)?property$/.test(d))
        ) {
          edge({ from: call.from, to: found.id, rel: 'calls', prov: 'binding', at: call.at });
          if (found.file !== record.file.id)
            edge({ from: record.file.id, to: found.file, rel: 'references', prov: 'binding', at: call.at });
        } else
          unresolved({
            from: call.from,
            rel: 'calls',
            target: call.target?.join('.') ?? '<expression>',
            at: call.at,
            reason: 'dynamic-external-or-unknown-call',
          });
      }
    }
  }
}
