import { posix } from 'node:path';
import type { CodeMapGraph } from '@shared/domain/code-map';
import type { FileRecord, GoRecord } from '../extract/record';
import { CodeMapLimitError, comparePaths } from '../enumerate';
import type { ProjectConfig } from './config';

export function parseGoConfig(path: string, source: string): ProjectConfig | null {
  const text = source.replace(/\/\/[^\n]*/g, '');
  if (posix.basename(path) === 'go.mod') {
    const module = /^\s*module\s+(?:"([^"\n]+)"|([^\s]+))/m.exec(text);
    if (!module) throw new Error('go.mod has no module directive');
    return { kind: 'go-module', data: { module: (module[1] ?? module[2]!).slice(0, 4096) } };
  }
  if (posix.basename(path) === 'go.work') {
    const uses = [...text.matchAll(/\buse\s+(?:\(([\s\S]*?)\)|([^\n]+))/g)]
      .flatMap((m) => (m[1] ?? m[2]!).match(/"[^"\n]+"|[^\s]+/g) ?? [])
      .map((v) => v.replace(/^"|"$/g, ''));
    return { kind: 'go-work', data: { uses: uses.slice(0, 2000) } };
  }
  return null;
}
type Declaration = GoRecord['declarations'][number] & { path: string; package: string };
const inside = (path: string, dir: string) => dir === '.' || path === dir || path.startsWith(dir + '/');

/** Go names bind within a directory/package and the explicitly available module workspace. No toolchain runs. */
export class GoResolver {
  private readonly directories = new Map<string, string[]>();
  private readonly declarations = new Map<string, Declaration[]>();
  private readonly modules: { directory: string; module: string }[] = [];
  private readonly workspaces: { directory: string; uses: Set<string> }[] = [];
  constructor(
    private readonly records: ReadonlyMap<string, FileRecord>,
    configs: ReadonlyMap<string, ProjectConfig>,
  ) {
    for (const [path, config] of configs) {
      const directory = posix.dirname(path);
      if (config.kind === 'go-module') this.modules.push({ directory, module: config.data.module });
      if (config.kind === 'go-work')
        this.workspaces.push({
          directory,
          uses: new Set(
            config.data.uses
              .map((p) => posix.normalize(posix.join(directory, p)))
              .filter((p) => p !== '..' && !p.startsWith('../') && !posix.isAbsolute(p)),
          ),
        });
    }
    this.modules.sort((a, b) => b.directory.length - a.directory.length || comparePaths(a.directory, b.directory));
    this.workspaces.sort((a, b) => b.directory.length - a.directory.length || comparePaths(a.directory, b.directory));
    for (const [path, record] of records) {
      if (!record.go) continue;
      const key = `${posix.dirname(path)}\0${record.go.package}`;
      const directory = posix.dirname(path),
        files = this.directories.get(directory) ?? [];
      files.push(path);
      this.directories.set(directory, files);
      for (const declaration of record.go.declarations)
        if (declaration.scope === 'file') {
          const entry = { ...declaration, path, package: key },
            lookup = `${key}\0${declaration.name}`;
          this.declarations.set(lookup, [...(this.declarations.get(lookup) ?? []), entry]);
        }
    }
    for (const paths of this.directories.values()) paths.sort(comparePaths);
  }
  private imported(path: string, module: string): string[] {
    const own = this.modules.find((m) => inside(path, m.directory));
    const workspace = this.workspaces.find((w) => inside(path, w.directory));
    const available = this.modules.filter((m) => m === own || workspace?.uses.has(m.directory));
    const matches = available.filter((m) => module === m.module || module.startsWith(m.module + '/'));
    const selected = matches.sort((a, b) => b.module.length - a.module.length)[0];
    if (!selected) return [];
    if (matches.filter((m) => m.module === selected.module).length !== 1) return [];
    const directory = posix.join(selected.directory, module.slice(selected.module.length));
    const files = (this.directories.get(directory) ?? []).filter((p) => !this.records.get(p)!.file.test);
    return new Set(files.map((p) => this.records.get(p)!.go!.package)).size === 1 ? files : [];
  }
  private packageOf(path: string) {
    return `${posix.dirname(path)}\0${this.records.get(path)!.go!.package}`;
  }
  private local(path: string, scope: string, name: string): GoRecord['locals'][number] | undefined {
    const record = this.records.get(path)!;
    for (
      let current: string | null = scope;
      current;
      current = record.scopes.find((s) => s.id === current)?.parent ?? null
    ) {
      const matches = record.go!.locals.filter((v) => v.scope === current && v.name === name);
      if (matches.length) return matches.length === 1 ? matches[0] : { scope: current, name, type: null };
    }
    return undefined;
  }
  private named(path: string, name: string, receiver?: string): Declaration[] {
    return (this.declarations.get(`${this.packageOf(path)}\0${name}`) ?? []).filter(
      (d) =>
        (!this.records.get(d.path)!.file.test || this.records.get(path)!.file.test) &&
        (receiver ? d.receiver === receiver : !d.receiver),
    );
  }
  private type(path: string, name: string, visited = new Set<string>()): Declaration | undefined {
    if (visited.size > 32 || visited.has(`${path}\0${name}`)) return undefined;
    visited.add(`${path}\0${name}`);
    const parts = name.split('.');
    let candidates: Declaration[];
    if (parts.length === 2) {
      const record = this.records.get(path)!;
      const imports = record.go!.imports.filter(
        (i) =>
          (i.alias ??
            this.records.get(this.imported(path, i.module)[0] ?? '')?.go?.package ??
            posix.basename(i.module)) === parts[0],
      );
      candidates = imports.flatMap((i) =>
        this.imported(path, i.module)
          .slice(0, 1)
          .flatMap((p) => this.named(p, parts[1]!).filter((d) => /^\p{Lu}/u.test(d.name))),
      );
    } else candidates = this.named(path, name);
    const types = candidates.filter((d) => d.typeKind);
    if (types.length !== 1) return undefined;
    const found = types[0]!;
    return found.typeKind === 'alias' && found.target ? this.type(found.path, found.target, visited) : found;
  }
  append(graph: CodeMapGraph, packageNodes: Map<string, CodeMapGraph['packages'][number]>, limit: number): void {
    const appendEdge = (edge: CodeMapGraph['edges'][number]) => {
      if (graph.edges.length >= limit) throw new CodeMapLimitError();
      graph.edges.push(edge);
    };
    const appendUnresolved = (entry: CodeMapGraph['unresolved'][number]) => {
      if (graph.unresolved.length >= limit) throw new CodeMapLimitError();
      graph.unresolved.push(entry);
    };
    const symbols = new Map(graph.symbols.map((s) => [s.id, s]));
    for (const [path, record] of [...this.records].sort(([a], [b]) => comparePaths(a, b))) {
      if (!record.go) continue;
      const go = record.go;
      for (const declaration of go.declarations)
        if (declaration.receiver) {
          const owner = this.type(path, declaration.receiver),
            symbol = symbols.get(declaration.symbol);
          if (owner && symbol) {
            symbol.owner = owner.symbol;
            appendEdge({ from: owner.symbol, to: symbol.id, rel: 'contains', prov: 'syntax' });
          }
        }
      for (const imported of go.imports) {
        const files = this.imported(path, imported.module);
        if (files.length)
          for (const p of files)
            appendEdge({ from: record.file.id, to: `f:${p}`, rel: 'imports', prov: 'binding', at: imported.at });
        else {
          const id = `p:go:${imported.module}`;
          packageNodes.set(id, { id, name: imported.module, external: true });
          appendEdge({ from: record.file.id, to: id, rel: 'imports', prov: 'syntax', at: imported.at });
        }
      }
      for (const call of go.calls) {
        let candidates: Declaration[] = [],
          reason = 'unknown-receiver-or-target';
        const parts = call.target ?? [];
        if (parts.length === 1 && !this.local(path, call.scope, parts[0]!)) {
          candidates = this.named(path, parts[0]!).filter((d) => !d.typeKind && d.parameters !== undefined);
          if (!candidates.length && go.imports.some((i) => i.alias === '.')) reason = 'dot-import-not-resolved';
        } else if (parts.length === 2) {
          const variable = this.local(path, call.scope, parts[0]!);
          if (variable) {
            const type = variable.type ? this.type(path, variable.type) : undefined;
            if (type?.typeKind === 'interface') reason = 'interface-dispatch';
            else if (type)
              candidates = this.named(type.path, parts[1]!, type.name).filter(
                (d) => d.package === this.packageOf(path) || /^\p{Lu}/u.test(d.name),
              );
          } else {
            const imports = go.imports.filter(
              (i) =>
                (i.alias ??
                  this.records.get(this.imported(path, i.module)[0] ?? '')?.go?.package ??
                  posix.basename(i.module)) === parts[0],
            );
            for (const imported of imports) {
              const first = this.imported(path, imported.module)[0];
              if (first)
                candidates.push(...this.named(first, parts[1]!).filter((d) => !d.typeKind && /^\p{Lu}/u.test(d.name)));
              else reason = 'external-package';
            }
          }
        }
        const ids = [...new Set(candidates.map((d) => d.symbol))];
        if (ids.length === 1) {
          const to = ids[0]!;
          appendEdge({ from: call.from, to, rel: 'calls', prov: 'binding', at: call.at });
          const file = symbols.get(to)?.file;
          if (file && file !== record.file.id)
            appendEdge({ from: record.file.id, to: file, rel: 'references', prov: 'binding', at: call.at });
        } else
          appendUnresolved({
            from: call.from,
            rel: 'calls',
            target: parts.join('.') || '<expression>',
            reason: ids.length > 1 ? 'ambiguous-build-variants' : reason,
            at: call.at,
          });
        if (graph.edges.length > limit || graph.unresolved.length > limit) throw new CodeMapLimitError();
      }
    }
  }
}
