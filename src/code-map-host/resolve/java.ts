import { posix } from 'node:path';
import type { CodeMapGraph, CodeMapSymbol } from '@shared/domain/code-map';
import type { FileRecord, JavaRecord } from '../extract/record';
import type { ProjectConfig } from './config';
import { CodeMapLimitError, comparePaths } from '../enumerate';

const simple = (name: string) =>
  name
    .replace(/<[^<>]*>/g, '')
    .replace(/\[\]|\.\.\./g, '')
    .trim();
const PRIMITIVES = new Set(['void', 'byte', 'short', 'int', 'long', 'float', 'double', 'boolean', 'char', 'var']);
export function parseJavaConfig(path: string, source: string): ProjectConfig | null {
  const name = posix.basename(path);
  if (name === 'pom.xml') {
    const clean = source.replace(/<!--[\s\S]*?-->/g, '');
    return {
      kind: 'java-project',
      data: {
        name: /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(clean)?.[1]?.slice(0, 1000) ?? posix.dirname(path),
        modules: [...clean.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!).slice(0, 2000),
      },
    };
  }
  if (/^settings\.gradle(?:\.kts)?$/.test(name)) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return {
      kind: 'java-project',
      data: {
        name: posix.dirname(path),
        modules: [...clean.matchAll(/\binclude\s*(?:\(([^\n]+)\)|([^\n]+))/g)]
          .flatMap((m) =>
            [...(m[1] ?? m[2]!).matchAll(/["']([^"']+)["']/g)].map((v) => v[1]!.replace(/^:/, '').replaceAll(':', '/')),
          )
          .slice(0, 2000),
      },
    };
  }
  return null;
}
type Type = JavaRecord['types'][number] & { path: string; package: string };
type Member = JavaRecord['members'][number] & { path: string };

/** Conservative nominal Java binding: no build execution, classpath downloads or runtime dispatch inference. */
export class JavaResolver {
  private readonly types = new Map<string, Type>();
  private readonly names = new Map<string, Type[]>();
  private readonly members = new Map<string, Member[]>();
  private readonly symbols = new Map<string, CodeMapSymbol>();
  private readonly locals = new Map<string, JavaRecord['locals']>();
  private readonly parents = new Map<string, string | null>();
  constructor(
    private readonly records: ReadonlyMap<string, FileRecord>,
    private readonly configs: ReadonlyMap<string, ProjectConfig>,
  ) {
    for (const [path, record] of records) {
      if (!record.java) continue;
      for (const symbol of record.symbols) this.symbols.set(symbol.id, symbol);
      for (const type of record.java.types) {
        const entry = { ...type, path, package: record.java.package };
        this.types.set(type.symbol, entry);
        const list = this.names.get(type.full) ?? [];
        list.push(entry);
        this.names.set(type.full, list);
      }
      for (const member of record.java.members) {
        const key = `${member.owner}\0${member.name}`,
          list = this.members.get(key) ?? [];
        list.push({ ...member, path });
        this.members.set(key, list);
      }
      for (const local of record.java.locals) {
        const key = `${path}\0${local.scope}\0${local.name}`,
          list = this.locals.get(key) ?? [];
        list.push(local);
        this.locals.set(key, list);
      }
      for (const scope of record.scopes) this.parents.set(`${path}\0${scope.id}`, scope.parent);
    }
  }
  private resolve(path: string, raw: string, owner: string | null): Type | undefined {
    const name = simple(raw),
      record = this.records.get(path)!;
    const find = (full: string) =>
      (this.names.get(full) ?? []).filter(
        (t) =>
          (!this.records.get(t.path)!.file.test || record.file.test) &&
          (t.package === record.java!.package || this.symbols.get(t.symbol)?.visibility === 'public'),
      );
    const unique = (entries: Type[]) => {
      const list = [...new Map(entries.map((t) => [t.symbol, t])).values()];
      return list.length === 1 ? list[0] : undefined;
    };
    if (name.includes('.')) {
      const exact = find(name);
      if (exact.length) return unique(exact);
    }
    for (
      let type = owner ? this.types.get(owner) : undefined;
      type;
      type = type.outer ? this.types.get(type.outer) : undefined
    ) {
      if (type.name === name) return type;
      const nested = find(`${type.full}.${name}`);
      if (nested.length) return unique(nested);
    }
    const imports = record.java!.imports.filter(
      (i) => !i.static && !i.wildcard && i.name.split('.').at(-1) === name.split('.')[0],
    );
    if (imports.length) return unique(imports.flatMap((i) => find(i.name + name.slice(name.split('.')[0]!.length))));
    const same = find(`${record.java!.package ? record.java!.package + '.' : ''}${name}`);
    if (same.length) return unique(same);
    return unique(
      record.java!.imports.filter((i) => !i.static && i.wildcard).flatMap((i) => find(`${i.name}.${name}`)),
    );
  }
  private bases(type: Type): Type[] {
    return type.bases.flatMap((b) => {
      const found = this.resolve(type.path, b.name, type.outer);
      return found ? [found] : [];
    });
  }
  private local(path: string, scope: string, name: string) {
    for (let current: string | null = scope; current; current = this.parents.get(`${path}\0${current}`) ?? null) {
      const entries = this.locals.get(`${path}\0${current}\0${name}`);
      if (entries?.length) return entries.length === 1 ? entries[0] : { scope: current, name, type: null };
    }
    return undefined;
  }
  private accessible(member: Member, path: string, owner: string | null): boolean {
    const visibility = this.symbols.get(member.symbol)?.visibility,
      type = this.types.get(member.owner)!;
    if (visibility === 'public' || owner === member.owner) return true;
    if (visibility === 'private') return false;
    if (this.records.get(path)!.java!.package === type.package) return true;
    if (visibility !== 'protected' || !owner) return false;
    const pending = [this.types.get(owner)!],
      seen = new Set<string>();
    for (const item of pending) {
      if (!item || seen.has(item.symbol) || seen.size >= 64) continue;
      if (item.symbol === member.owner) return true;
      seen.add(item.symbol);
      pending.push(...this.bases(item));
    }
    return false;
  }
  private lookup(
    type: Type,
    name: string,
    path: string,
    owner: string | null,
    args?: number,
    staticOnly = false,
  ): Member[] {
    let level = [type];
    const seen = new Set<string>();
    while (level.length && seen.size < 64) {
      const found: Member[] = [],
        next: Type[] = [];
      for (const current of level) {
        if (seen.has(current.symbol)) continue;
        seen.add(current.symbol);
        found.push(
          ...(this.members.get(`${current.symbol}\0${name}`) ?? []).filter(
            (m) =>
              this.accessible(m, path, owner) &&
              (!staticOnly || m.static) &&
              (args === undefined
                ? m.parameters === null
                : m.parameters !== null && (m.variadic ? args >= m.parameters - 1 : args === m.parameters)),
          ),
        );
        next.push(...this.bases(current));
      }
      if (found.length) return found;
      level = next;
    }
    return [];
  }
  private receiver(
    path: string,
    scope: string,
    owner: string | null,
    value: string,
  ): { type: Type; static: boolean } | undefined {
    const current = owner ? this.types.get(owner) : undefined;
    if (value === 'this') return current ? { type: current, static: false } : undefined;
    if (value === 'super') {
      const base = current
        ? this.bases(current).find((t) => this.symbols.get(t.symbol)?.kind !== 'interface')
        : undefined;
      return base ? { type: base, static: false } : undefined;
    }
    const variable = this.local(path, scope, value);
    if (variable) {
      const type = variable.type ? this.resolve(path, variable.type, owner) : undefined;
      return type ? { type, static: false } : undefined;
    }
    const fieldName = value.startsWith('this.') ? value.slice(5) : value;
    if (current && !fieldName.includes('.')) {
      const fields = this.lookup(current, fieldName, path, owner);
      if (fields.length) {
        const type =
          fields.length === 1 && fields[0]!.type
            ? this.resolve(fields[0]!.path, fields[0]!.type, fields[0]!.owner)
            : undefined;
        return type ? { type, static: false } : undefined;
      }
    }
    const type = this.resolve(path, value, owner);
    return type ? { type, static: true } : undefined;
  }
  append(graph: CodeMapGraph, packages: Map<string, CodeMapGraph['packages'][number]>, limit: number) {
    const appendEdge = (edge: CodeMapGraph['edges'][number]) => {
      if (graph.edges.length >= limit) throw new CodeMapLimitError();
      graph.edges.push(edge);
    };
    const appendUnresolved = (entry: CodeMapGraph['unresolved'][number]) => {
      if (graph.unresolved.length >= limit) throw new CodeMapLimitError();
      graph.unresolved.push(entry);
    };
    const reference = (from: string, to: Type, at: [number, number]) => {
      appendEdge({ from, to: to.symbol, rel: 'references', prov: 'binding', at });
      const file = this.symbols.get(from)?.file;
      if (file && file !== `f:${to.path}`)
        appendEdge({ from: file, to: `f:${to.path}`, rel: 'references', prov: 'binding', at });
    };
    for (const [path, record] of [...this.records].sort(([a], [b]) => comparePaths(a, b))) {
      if (!record.java) continue;
      const java = record.java;
      for (const imported of java.imports) {
        const className =
          imported.static && !imported.wildcard
            ? imported.name.slice(0, imported.name.lastIndexOf('.'))
            : imported.name;
        const types = (
          imported.wildcard && !imported.static
            ? [...this.types.values()].filter(
                (t) =>
                  t.package === imported.name &&
                  this.symbols.get(t.symbol)?.visibility === 'public' &&
                  !this.records.get(t.path)!.file.test,
              )
            : (this.names.get(className) ?? [])
        ).filter(
          (t) =>
            (!this.records.get(t.path)!.file.test || record.file.test) &&
            (t.package === java.package || this.symbols.get(t.symbol)?.visibility === 'public'),
        );
        if ((!imported.wildcard || imported.static) && types.length > 1) {
          appendUnresolved({
            from: record.file.id,
            rel: 'imports',
            target: imported.name,
            at: imported.at,
            reason: 'ambiguous-type-import',
          });
          continue;
        }
        if (types.length)
          for (const type of types)
            appendEdge({
              from: record.file.id,
              to: `f:${type.path}`,
              rel: 'imports',
              prov: 'binding',
              at: imported.at,
            });
        else {
          const id = `p:java:${className}`;
          packages.set(id, { id, name: className, external: true });
          appendEdge({ from: record.file.id, to: id, rel: 'imports', prov: 'syntax', at: imported.at });
        }
      }
      for (const declared of java.types)
        for (const base of declared.bases) {
          const type = this.resolve(path, base.name, declared.outer);
          if (type) appendEdge({ from: declared.symbol, to: type.symbol, rel: base.rel, prov: 'binding', at: base.at });
          else
            appendUnresolved({
              from: declared.symbol,
              rel: base.rel,
              target: base.name,
              at: base.at,
              reason: 'external-or-ambiguous-type',
            });
        }
      for (const item of java.references) {
        const type = this.resolve(path, item.name, item.owner);
        if (type) reference(item.from, type, item.at);
        else if (!PRIMITIVES.has(simple(item.name)))
          appendUnresolved({
            from: item.from,
            rel: 'references',
            target: item.name,
            at: item.at,
            reason: 'external-or-ambiguous-type',
          });
      }
      for (const call of java.calls) {
        let candidates: Member[] = [];
        if (call.constructor) {
          const type = this.resolve(path, call.target, call.owner);
          if (type)
            candidates = (this.members.get(`${type.symbol}\0${type.name}`) ?? []).filter(
              (m) =>
                m.constructor &&
                this.accessible(m, path, call.owner) &&
                (m.variadic ? call.args >= (m.parameters ?? 0) - 1 : m.parameters === call.args),
            );
        } else if (call.receiver) {
          const receiver = this.receiver(path, call.scope, call.owner, call.receiver);
          if (receiver)
            candidates = this.lookup(receiver.type, call.target, path, call.owner, call.args, receiver.static);
        } else {
          const type = call.owner ? this.types.get(call.owner) : undefined;
          let staticOnly = false;
          for (let scope: string | null = call.scope; scope; scope = this.parents.get(`${path}\0${scope}`) ?? null) {
            const entry = record.scopes.find((s) => s.id === scope);
            if (entry?.kind === 'function') {
              staticOnly = entry.staticThis;
              break;
            }
          }
          if (type) candidates = this.lookup(type, call.target, path, call.owner, call.args, staticOnly);
          if (!candidates.length)
            for (const imported of java.imports.filter(
              (i) => i.static && (i.wildcard || i.name.endsWith('.' + call.target)),
            )) {
              const type = this.resolve(
                path,
                imported.wildcard ? imported.name : imported.name.slice(0, imported.name.lastIndexOf('.')),
                call.owner,
              );
              if (type) candidates.push(...this.lookup(type, call.target, path, call.owner, call.args, true));
            }
        }
        const ids = [...new Set(candidates.map((m) => m.symbol))];
        if (ids.length === 1) {
          appendEdge({ from: call.from, to: ids[0]!, rel: 'calls', prov: 'binding', at: call.at });
          const file = this.symbols.get(ids[0]!)?.file;
          if (file && file !== record.file.id)
            appendEdge({ from: record.file.id, to: file, rel: 'references', prov: 'binding', at: call.at });
        } else
          appendUnresolved({
            from: call.from,
            rel: 'calls',
            target: `${call.receiver ? call.receiver + '.' : ''}${call.target}`,
            at: call.at,
            reason: ids.length > 1 ? 'ambiguous-overload' : 'external-implicit-or-unknown-target',
          });
        if (graph.edges.length > limit || graph.unresolved.length > limit) throw new CodeMapLimitError();
      }
    }
    for (const [path, config] of this.configs)
      if (config.kind === 'java-project') {
        const directory = posix.dirname(path),
          files = graph.files.filter(
            (f) => this.records.get(f.path)?.java && (directory === '.' || f.path.startsWith(directory + '/')),
          );
        graph.groups.push({
          id: `j:${path}`,
          kind: 'project',
          name: config.data.name || 'Java project',
          path: directory,
          files: files.length,
          parent: `d:${directory}`,
        });
        for (const module of config.data.modules) {
          const target = posix.normalize(posix.join(directory, module));
          if (
            target === '..' ||
            target.startsWith('../') ||
            posix.isAbsolute(target) ||
            this.configs.has(`${target}/pom.xml`)
          )
            continue;
          const children = graph.files.filter((f) => this.records.get(f.path)?.java && f.path.startsWith(target + '/'));
          if (children.length)
            graph.groups.push({
              id: `j:${path}#${target}`,
              kind: 'project',
              name: module.slice(0, 1024),
              path: target,
              files: children.length,
              parent: `j:${path}`,
            });
        }
      }
    if (graph.edges.length > limit || graph.unresolved.length > limit) throw new CodeMapLimitError();
  }
}
