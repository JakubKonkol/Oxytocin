import { posix } from 'node:path';
import type { CodeMapEdge, CodeMapGraph, CodeMapSymbol } from '@shared/domain/code-map';
import { CodeMapLimitError, comparePaths } from '../enumerate';
import type { CSharpRecord, CSharpTypeRef, FileRecord, Scope } from '../extract/record';
import type { ProjectConfig } from './config';
import { implicitUsings, type DotnetProject } from './dotnet-projects';

type Usings = CSharpRecord['globalUsings'];
type Member = CSharpRecord['members'][number] & { path: string };
type Local = CSharpRecord['locals'][number];
type Relation = CSharpRecord['relations'][number];
interface Project {
  key: string;
  name: string;
  directory: string;
  data: DotnetProject | null;
  visible: Set<string>;
  usings: Usings;
  test: boolean;
  solutions: string[];
}
interface Part {
  path: string;
  symbol: string;
  scope: string;
  bases: CSharpRecord['types'][number]['bases'];
}
interface TypeEntry {
  id: string;
  project: string;
  full: string;
  name: string;
  arity: number;
  kind: CSharpRecord['types'][number]['kind'];
  partial: boolean;
  parts: Part[];
  members: Member[];
}
interface Bases {
  base: TypeEntry | null;
  interfaces: TypeEntry[];
  edges: { to: string; rel: 'extends' | 'implements'; at: [number, number]; path: string; from: string }[];
  unresolved: { from: string; target: string; at: [number, number]; reason: string }[];
}
type Found =
  | { kind: 'type'; entry: TypeEntry }
  | { kind: 'parameter' }
  | { kind: 'namespace' }
  | { kind: 'unknown'; reason: string };
type Value = { kind: 'instance' | 'static'; entry: TypeEntry } | { kind: 'unknown'; reason: string };
type Target = { kind: 'edges'; ids: string[]; prov: 'binding' | 'heuristic' } | { kind: 'unknown'; reason: string };

const LOOSE = '';
const PUBLIC = ['public', 'protected', 'protected internal'];
const VISIBILITY_ORDER = [
  'public',
  'protected internal',
  'protected',
  'internal',
  'private protected',
  'private',
  'file',
];
const TEST_PACKAGES = ['microsoft.net.test.sdk', 'xunit', 'nunit', 'mstest.testframework', 'mstest'];
const segment = (value: string) => {
  const match = /^(.*)\/(\d+)$/.exec(value);
  return match ? { name: match[1]!, arity: Number(match[2]) } : { name: value, arity: 0 };
};
const join = (...parts: string[]) => parts.filter(Boolean).join('.');
const keyOf = (full: string, arity: number) => `${full}/${arity}`;
const unknown = (reason: string) => ({ kind: 'unknown' as const, reason });
const emptyUsings = (): Usings => ({ namespaces: [], statics: [], aliases: [] });

/**
 * Binds C# names without a compiler: namespaces, using directives, project references and declared types only.
 * Anything ambiguous or outside the indexed projects stays unresolved with a reason.
 */
export class CSharpResolver {
  /** Secondary partial declarations → the merged (primary) type symbol. */
  readonly aliases = new Map<string, string>();
  readonly parts = new Map<string, { file: string; span: CodeMapSymbol['span'] }[]>();
  readonly visibility = new Map<string, CodeMapSymbol['visibility']>();
  readonly projects = new Map<string, Project>();
  private readonly fileProject = new Map<string, Project>();
  private readonly byFull = new Map<string, TypeEntry[]>();
  private readonly bySymbol = new Map<string, TypeEntry>();
  private readonly symbolFile = new Map<string, string>();
  private readonly scopes = new Map<string, Map<string, Scope>>();
  private readonly contexts = new Map<string, Map<string, CSharpRecord['contexts'][number]>>();
  private readonly locals = new Map<string, Map<string, Local[]>>();
  private readonly fileUsings = new Map<string, Usings>();
  private readonly namespaces = new Set<string>();
  private readonly bases = new Map<string, Bases | null>();
  private readonly fileReferences = new Map<string, [number, number]>();
  readonly paths: string[];
  constructor(
    private readonly records: ReadonlyMap<string, FileRecord>,
    private readonly configs: ReadonlyMap<string, ProjectConfig>,
  ) {
    this.paths = [...records.keys()].filter((path) => records.get(path)!.csharp).sort(comparePaths);
    this.loadProjects();
    for (const [path, record] of records) for (const symbol of record.symbols) this.symbolFile.set(symbol.id, path);
    for (const path of this.paths) {
      const record = records.get(path)!;
      const csharp = record.csharp!;
      this.scopes.set(path, new Map(record.scopes.map((scope) => [scope.id, scope])));
      this.contexts.set(path, new Map(csharp.contexts.map((context) => [context.scope, context])));
      const locals = new Map<string, Local[]>();
      for (const local of csharp.locals) {
        const key = `${local.scope}\0${local.name}`;
        locals.set(key, [...(locals.get(key) ?? []), local]);
      }
      this.locals.set(path, locals);
      for (const context of csharp.contexts)
        if (context.namespace)
          for (
            let name = context.namespace;
            name;
            name = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : ''
          )
            this.namespaces.add(name);
      const symbols = new Map(record.symbols.map((symbol) => [symbol.id, symbol]));
      const project = this.projectOf(path);
      for (const type of csharp.types) {
        const full = join(type.container, type.name);
        const key = keyOf(full, type.arity);
        const candidates = this.byFull.get(key) ?? [];
        const part: Part = { path, symbol: type.symbol, scope: type.scope, bases: type.bases };
        const merged =
          type.partial &&
          candidates.find((entry) => entry.project === project.key && entry.partial && entry.kind === type.kind);
        const own = symbols.get(type.symbol);
        if (merged) {
          merged.parts.push(part);
          this.aliases.set(type.symbol, merged.id);
          this.bySymbol.set(type.symbol, merged);
          if (own) {
            this.parts.set(merged.id, [...(this.parts.get(merged.id) ?? []), { file: own.file, span: own.span }]);
            const current = this.visibility.get(merged.id);
            if (
              own.visibility &&
              (!current || VISIBILITY_ORDER.indexOf(own.visibility) < VISIBILITY_ORDER.indexOf(current))
            )
              this.visibility.set(merged.id, own.visibility);
          }
          continue;
        }
        const entry: TypeEntry = {
          id: type.symbol,
          project: project.key,
          full,
          name: type.name,
          arity: type.arity,
          kind: type.kind,
          partial: type.partial,
          parts: [part],
          members: [],
        };
        if (own?.visibility) this.visibility.set(entry.id, own.visibility);
        candidates.push(entry);
        this.byFull.set(key, candidates);
        this.bySymbol.set(type.symbol, entry);
      }
    }
    for (const path of this.paths)
      for (const member of this.records.get(path)!.csharp!.members)
        this.bySymbol.get(member.owner)?.members.push({ ...member, path });
  }
  private loadProjects(): void {
    const props = new Map<string, DotnetProject>();
    const solutions = new Map<string, string[]>();
    // Windows resolves project paths case-insensitively: match a project file that differs only in case, if unique.
    const byLowerPath = new Map<string, string[]>();
    for (const [path, config] of this.configs)
      if (config.kind === 'dotnet-project')
        byLowerPath.set(path.toLowerCase(), [...(byLowerPath.get(path.toLowerCase()) ?? []), path]);
    const canonical = (reference: string): string => {
      if (this.configs.get(reference)?.kind === 'dotnet-project') return reference;
      const matches = byLowerPath.get(reference.toLowerCase());
      return matches?.length === 1 ? matches[0]! : reference;
    };
    for (const [path, config] of [...this.configs].sort(([left], [right]) => comparePaths(left, right))) {
      if (config.kind === 'dotnet-props') props.set(posix.dirname(path), config.data);
      if (config.kind === 'dotnet-solution')
        for (const project of config.data.projects.map(canonical))
          solutions.set(project, [...(solutions.get(project) ?? []), path]);
    }
    const inherited = (directory: string): DotnetProject | null => {
      for (let current = directory; ; current = posix.dirname(current)) {
        const found = props.get(current);
        if (found) return found;
        if (current === '.') return null;
      }
    };
    for (const [path, config] of [...this.configs].sort(([left], [right]) => comparePaths(left, right))) {
      if (config.kind !== 'dotnet-project') continue;
      const directory = posix.dirname(path);
      const base = inherited(directory);
      const own = config.data;
      const data: DotnetProject = {
        ...own,
        projectReferences: own.projectReferences.map(canonical),
        rootNamespace: own.rootNamespace ?? base?.rootNamespace ?? null,
        targetFrameworks: own.targetFrameworks.length ? own.targetFrameworks : (base?.targetFrameworks ?? []),
        implicitUsings: own.implicitUsings ?? base?.implicitUsings ?? null,
        isTestProject: own.isTestProject ?? base?.isTestProject ?? null,
        packageReferences: [...new Set([...(base?.packageReferences ?? []), ...own.packageReferences])],
        usings: [...(base?.usings ?? []), ...own.usings],
        usingRemoves: [...(base?.usingRemoves ?? []), ...own.usingRemoves],
      };
      const usings = emptyUsings();
      if (data.implicitUsings) usings.namespaces.push(...implicitUsings(data.sdk));
      for (const item of data.usings)
        if (item.alias) usings.aliases.push({ name: item.alias, target: item.name.split('.') });
        else if (item.static) usings.statics.push(item.name.split('.'));
        else usings.namespaces.push(item.name);
      usings.namespaces = usings.namespaces.filter((name) => !data.usingRemoves.includes(name));
      this.projects.set(path, {
        key: path,
        name: posix.basename(path).replace(/\.csproj$/i, ''),
        directory,
        data,
        visible: new Set([path]),
        usings,
        test:
          data.isTestProject === true ||
          data.packageReferences.some((name) => TEST_PACKAGES.includes(name.toLowerCase())),
        solutions: solutions.get(path) ?? [],
      });
    }
    for (const project of this.projects.values()) {
      const queue = [...(project.data?.projectReferences ?? [])];
      for (let index = 0; index < queue.length && index < 10_000; index++) {
        const reference = this.projects.get(queue[index]!);
        if (!reference || project.visible.has(reference.key)) continue;
        project.visible.add(reference.key);
        queue.push(...(reference.data?.projectReferences ?? []));
      }
    }
    this.projects.set(LOOSE, {
      key: LOOSE,
      name: '',
      directory: '.',
      data: null,
      visible: new Set([LOOSE]),
      usings: emptyUsings(),
      test: false,
      solutions: [],
    });
    for (const path of this.paths) {
      const project = this.projectOf(path);
      const usings = this.records.get(path)!.csharp!.globalUsings;
      project.usings.namespaces.push(...usings.namespaces);
      project.usings.statics.push(...usings.statics);
      project.usings.aliases.push(...usings.aliases);
    }
  }
  /** The nearest project folder above a file, unless the project removes it from compilation. */
  projectOf(path: string): Project {
    const cached = this.fileProject.get(path);
    if (cached) return cached;
    let found = this.projects.get(LOOSE)!;
    for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
      const project = [...this.projects.values()].find(
        (candidate) => candidate.key && candidate.directory === directory,
      );
      if (project) {
        const relative = directory === '.' ? path : path.slice(directory.length + 1);
        if (!(project.data?.compileRemove ?? []).some((glob) => posix.matchesGlob(relative, glob))) found = project;
        break;
      }
      if (directory === '.') break;
    }
    this.fileProject.set(path, found);
    return found;
  }
  isTestFile(path: string): boolean {
    return path.endsWith('.cs') && this.projectOf(path).test;
  }
  private find(full: string, arity: number, visible: Set<string>): TypeEntry[] {
    return (this.byFull.get(keyOf(full, arity)) ?? []).filter((entry) => visible.has(entry.project));
  }
  private one(entries: TypeEntry[]): Found | null {
    const unique = [...new Set(entries)];
    if (unique.length === 1) return { kind: 'type', entry: unique[0]! };
    return unique.length ? unknown('ambiguous-type') : null;
  }
  private usings(path: string): Usings {
    let cached = this.fileUsings.get(path);
    if (!cached) {
      const own = this.contexts.get(path)?.get('file')?.usings ?? emptyUsings();
      const project = this.projectOf(path).usings;
      cached = {
        namespaces: [...new Set([...own.namespaces, ...project.namespaces])],
        statics: [...own.statics, ...project.statics],
        aliases: [...own.aliases, ...project.aliases],
      };
      this.fileUsings.set(path, cached);
    }
    return cached;
  }
  /** Fully qualified lookup from the global namespace, as used by using directives. */
  private qualified(name: string[], visible: Set<string>): Found {
    for (let index = 0; index < name.length; index++) {
      const { name: last, arity } = segment(name[index]!);
      const namespace = name.slice(0, index).map((part) => segment(part).name);
      const found = this.one(this.find(join(...namespace, last), arity, visible));
      if (found) return found.kind === 'type' ? this.nested(found.entry, name.slice(index + 1), visible) : found;
    }
    return this.namespaces.has(name.map((part) => segment(part).name).join('.'))
      ? { kind: 'namespace' }
      : unknown('external-or-unknown-type');
  }
  private nested(entry: TypeEntry, rest: string[], visible: Set<string>): Found {
    let current = entry;
    for (const part of rest) {
      const { name, arity } = segment(part);
      const found = this.one(this.find(join(current.full, name), arity, visible));
      if (found?.kind !== 'type') return found ?? unknown('nested-type-not-found');
      current = found.entry;
    }
    return { kind: 'type', entry: current };
  }
  private fromUsings(usings: Usings, part: { name: string; arity: number }, visible: Set<string>): Found | null {
    const matches: TypeEntry[] = [];
    if (part.arity === 0)
      for (const alias of usings.aliases)
        if (alias.name === part.name) {
          const found = this.qualified(alias.target, visible);
          if (found.kind === 'type') matches.push(found.entry);
          else if (found.kind === 'namespace') return found;
        }
    for (const namespace of usings.namespaces)
      matches.push(...this.find(join(namespace, part.name), part.arity, visible));
    for (const target of usings.statics) {
      const found = this.qualified(target, visible);
      if (found.kind === 'type') matches.push(...this.find(join(found.entry.full, part.name), part.arity, visible));
    }
    return this.one(matches);
  }
  private scopeChain(path: string, scope: string): Scope[] {
    const scopes = this.scopes.get(path);
    const chain: Scope[] = [];
    for (let current = scopes?.get(scope); current && chain.length < 1000; current = scopes?.get(current.parent ?? ''))
      chain.push(current);
    return chain;
  }
  private enclosingNamespaces(path: string, scope: string): string[] {
    const names: string[] = [];
    for (const current of this.scopeChain(path, scope)) {
      const namespace = this.contexts.get(path)?.get(current.id)?.namespace;
      if (namespace) names.push(namespace);
    }
    return names;
  }
  /** Resolves the first segment of a type name through the C# lookup order. */
  private first(path: string, scope: string, part: { name: string; arity: number }): Found | null {
    const visible = this.projectOf(path).visible;
    const contexts = this.contexts.get(path);
    const chain = this.scopeChain(path, scope);
    for (let index = 0; index < chain.length; index++) {
      const current = chain[index]!;
      const context = contexts?.get(current.id);
      if (part.arity === 0 && context?.typeParameters?.includes(part.name)) return { kind: 'parameter' };
      if (current.kind === 'class' && current.thisClass) {
        for (let type = this.bySymbol.get(current.thisClass), depth = 0; type && depth < 20; depth++) {
          const found = this.one(this.find(join(type.full, part.name), part.arity, visible));
          if (found) return found;
          type = this.baseTypes(type)?.base ?? undefined;
        }
      }
      if (context?.namespace) {
        const parent = chain.slice(index + 1).find((scope) => contexts?.get(scope.id)?.namespace);
        const parentName = parent ? contexts!.get(parent.id)!.namespace! : '';
        const found =
          this.one(this.find(join(context.namespace, part.name), part.arity, visible)) ??
          (context.usings ? this.fromUsings(context.usings, part, visible) : null);
        if (found) return found;
        for (
          let prefix = context.namespace.slice(0, Math.max(0, context.namespace.lastIndexOf('.')));
          prefix.length > parentName.length;
          prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('.')))
        ) {
          const outer = this.one(this.find(join(prefix, part.name), part.arity, visible));
          if (outer) return outer;
        }
      }
      if (current.id === 'file')
        return this.one(this.find(part.name, part.arity, visible)) ?? this.fromUsings(this.usings(path), part, visible);
    }
    return null;
  }
  resolveType(path: string, scope: string, name: string[], attribute = false): Found {
    const visible = this.projectOf(path).visible;
    if (attribute && name.length) {
      const last = segment(name.at(-1)!);
      if (!last.name.endsWith('Attribute')) {
        const found = this.resolveType(path, scope, [...name.slice(0, -1), `${last.name}Attribute`]);
        if (found.kind === 'type') return found;
      }
    }
    const head = segment(name[0]!);
    const first = this.first(path, scope, head);
    if (first?.kind === 'type') return this.nested(first.entry, name.slice(1), visible);
    if (first && first.kind !== 'namespace') return first;
    if (name.length > 1)
      for (const namespace of [...this.enclosingNamespaces(path, scope), '']) {
        for (let index = 1; index < name.length; index++) {
          const { name: last, arity } = segment(name[index]!);
          const qualifier = name.slice(0, index).map((part) => segment(part).name);
          const found = this.one(this.find(join(namespace, ...qualifier, last), arity, visible));
          if (found) return found.kind === 'type' ? this.nested(found.entry, name.slice(index + 1), visible) : found;
        }
      }
    return this.namespaces.has(head.name) ||
      [...this.namespaces].some((namespace) => namespace.endsWith(`.${head.name}`))
      ? unknown(name.length > 1 ? 'type-not-found' : 'unknown-type')
      : unknown('external-or-unknown-type');
  }
  private ref(path: string, ref: CSharpTypeRef | null): Found {
    return ref ? this.resolveType(path, ref.scope, ref.name) : unknown('unknown-declared-type');
  }
  baseTypes(entry: TypeEntry): Bases | null {
    if (this.bases.has(entry.id)) return this.bases.get(entry.id) ?? null;
    this.bases.set(entry.id, null);
    const result: Bases = { base: null, interfaces: [], edges: [], unresolved: [] };
    for (const part of entry.parts)
      for (const base of part.bases) {
        const found = this.resolveType(part.path, base.scope, base.name);
        if (found.kind !== 'type') {
          if (found.kind === 'unknown')
            result.unresolved.push({
              from: part.symbol,
              target: base.name.join('.'),
              at: base.at,
              reason: found.reason,
            });
          continue;
        }
        const target = found.entry;
        const isInterface = target.kind === 'interface';
        if (!isInterface && !result.base && ['class', 'record'].includes(entry.kind) && target.id !== entry.id)
          result.base = target;
        else if (isInterface) result.interfaces.push(target);
        result.edges.push({
          from: part.symbol,
          to: target.id,
          rel: isInterface && entry.kind !== 'interface' ? 'implements' : 'extends',
          at: base.at,
          path: part.path,
        });
      }
    this.bases.set(entry.id, result);
    return result;
  }
  /** Members by name on a type and its indexed base types (and interfaces when nothing else matches). */
  private members(entry: TypeEntry, name: string, accept: (member: Member) => boolean): Member[] {
    const seen = new Set<string>();
    const queue: TypeEntry[] = [entry];
    let found: Member[] = [];
    for (let index = 0; index < queue.length && index < 200; index++) {
      const current = queue[index]!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      found = [...found, ...current.members.filter((member) => member.name === name && accept(member))];
      const bases = this.baseTypes(current);
      if (found.length && current.kind !== 'interface') break;
      if (bases?.base) queue.push(bases.base);
      if (!found.length || current.kind === 'interface') queue.push(...(bases?.interfaces ?? []));
    }
    return found;
  }
  private local(path: string, scope: string, name: string): Local | null {
    const locals = this.locals.get(path);
    for (const current of this.scopeChain(path, scope)) {
      const list = locals?.get(`${current.id}\0${name}`);
      if (list?.length) return list.at(-1)!;
    }
    return null;
  }
  private thisType(path: string, scope: string): { entry: TypeEntry | undefined; staticThis: boolean } {
    const current = this.scopes.get(path)?.get(scope);
    return {
      entry: current?.thisClass ? this.bySymbol.get(current.thisClass) : undefined,
      staticThis: current?.staticThis ?? false,
    };
  }
  private outerTypes(entry: TypeEntry | undefined): TypeEntry[] {
    const result: TypeEntry[] = [];
    for (let current = entry; current && result.length < 50;) {
      const part = current.parts[0]!;
      const outer = this.records.get(part.path)!.csharp!.types.find((type) => type.symbol === part.symbol)?.outer;
      current = outer ? this.bySymbol.get(outer) : undefined;
      if (current) result.push(current);
    }
    return result;
  }
  private valueOf(member: Member, owner: TypeEntry): Value {
    if (member.kind === 'enum-member') return { kind: 'instance', entry: owner };
    const found = this.ref(member.path, member.type);
    if (found.kind === 'type') return { kind: 'instance', entry: found.entry };
    return unknown(
      found.kind === 'parameter'
        ? 'generic-receiver-type'
        : found.kind === 'unknown'
          ? found.reason
          : 'unknown-receiver-type',
    );
  }
  resolveValue(path: string, scope: string, name: string[]): Value {
    const head = segment(name[0]!).name;
    const visible = this.projectOf(path).visible;
    let value: Value | null = null;
    let index = 1;
    const local = this.local(path, scope, head);
    if (local) {
      if (local.symbol) return unknown('method-group');
      const found = this.ref(path, local.type);
      value =
        found.kind === 'type'
          ? { kind: 'instance', entry: found.entry }
          : unknown(
              found.kind === 'parameter'
                ? 'generic-receiver-type'
                : found.kind === 'unknown' && local.type
                  ? found.reason
                  : 'unknown-local-type',
            );
    }
    if (!value) {
      const { entry, staticThis } = this.thisType(path, scope);
      for (const [type, onlyStatic] of [
        ...(entry ? [[entry, staticThis] as const] : []),
        ...this.outerTypes(entry).map((outer) => [outer, true] as const),
      ]) {
        const members = this.members(type, head, (member) =>
          ['field', 'property', 'event', 'enum-member'].includes(member.kind),
        ).filter((member) => member.static || !onlyStatic);
        if (members.length) {
          value = members.length === 1 ? this.valueOf(members[0]!, type) : unknown('ambiguous-member');
          break;
        }
      }
    }
    if (!value)
      for (let length = 1; length <= name.length; length++) {
        const found = this.resolveType(path, scope, name.slice(0, length));
        if (found.kind === 'type') {
          value = { kind: 'static', entry: found.entry };
          index = length;
          break;
        }
        if (found.kind === 'parameter') return unknown('generic-receiver-type');
      }
    if (!value) {
      const found = this.resolveType(path, scope, [name[0]!]);
      return unknown(found.kind === 'unknown' ? found.reason : 'unknown-receiver');
    }
    for (; index < name.length && value.kind !== 'unknown'; index++) {
      const { name: part, arity } = segment(name[index]!);
      const current: TypeEntry = value.entry;
      const isStatic: boolean = value.kind === 'static';
      const members = this.members(
        current,
        part,
        (member) => ['field', 'property', 'event', 'enum-member'].includes(member.kind) && member.static === isStatic,
      );
      if (members.length === 1) value = this.valueOf(members[0]!, current);
      else if (members.length) value = unknown('ambiguous-member');
      else if (isStatic) {
        const nested = this.one(this.find(join(current.full, part), arity, visible));
        value = nested?.kind === 'type' ? { kind: 'static', entry: nested.entry } : unknown('member-not-found');
      } else value = unknown('member-not-found');
    }
    return value;
  }
  private overloads(candidates: Member[], args: number): Target | null {
    if (!candidates.length) return null;
    const matching = candidates.filter(
      (member) => !member.parameters || (member.parameters[0] <= args && args <= member.parameters[1]),
    );
    if (!matching.length) return unknown('no-overload-for-argument-count');
    const ids = [...new Set(matching.map((member) => member.symbol))].sort(comparePaths);
    return { kind: 'edges', ids, prov: ids.length === 1 ? 'binding' : 'heuristic' };
  }
  private constructors(entry: TypeEntry, args: number): Target {
    const constructors = entry.members.filter((member) => member.kind === 'constructor');
    if (!constructors.length) return { kind: 'edges', ids: [entry.id], prov: 'binding' };
    return this.overloads(constructors, args) ?? unknown('no-overload-for-argument-count');
  }
  private methods(entry: TypeEntry, name: string, args: number, filter: (member: Member) => boolean): Target | null {
    return this.overloads(
      this.members(entry, name, (member) => member.kind === 'method' && filter(member)),
      args,
    );
  }
  private call(path: string, relation: Relation): Target {
    const name = relation.target[0]!;
    const args = relation.args ?? 0;
    const receiver = relation.receiver ?? { kind: 'none' };
    const { entry, staticThis } = this.thisType(path, relation.scope);
    if (relation.syntax === 'new' && receiver.kind === 'none') {
      const found = this.resolveType(path, relation.scope, relation.target);
      if (found.kind !== 'type') return unknown(found.kind === 'unknown' ? found.reason : 'generic-type-parameter');
      return found.entry.kind === 'interface'
        ? unknown('interface-construction')
        : this.constructors(found.entry, args);
    }
    switch (receiver.kind) {
      case 'none': {
        const local = this.local(path, relation.scope, name);
        if (local?.symbol)
          return !local.parameters || (local.parameters[0] <= args && args <= local.parameters[1])
            ? { kind: 'edges', ids: [local.symbol], prov: 'binding' }
            : unknown('no-overload-for-argument-count');
        if (local) return unknown('delegate-invocation');
        if (entry) {
          const own = this.methods(entry, name, args, (member) => member.static || !staticThis);
          if (own) return own;
        }
        for (const outer of this.outerTypes(entry)) {
          const found = this.methods(outer, name, args, (member) => member.static);
          if (found) return found;
        }
        const statics: Target[] = [];
        const visible = this.projectOf(path).visible;
        for (const target of this.usings(path).statics) {
          const found = this.qualified(target, visible);
          const methods =
            found.kind === 'type' ? this.methods(found.entry, name, args, (member) => member.static) : null;
          if (methods) statics.push(methods);
        }
        if (statics.length === 1) return statics[0]!;
        if (statics.length) return unknown('ambiguous-static-import');
        if (entry && this.members(entry, name, (member) => member.kind !== 'method').length)
          return unknown('delegate-invocation');
        return unknown('method-not-found');
      }
      case 'this':
      case 'base': {
        const owner = receiver.kind === 'this' ? entry : entry && this.baseTypes(entry)?.base;
        if (!owner) return unknown(receiver.kind === 'this' ? 'dynamic-this' : 'base-type-not-indexed');
        if (name === '.ctor') return this.constructors(owner, args);
        return this.methods(owner, name, args, (member) => !member.static) ?? unknown('member-not-found');
      }
      case 'name': {
        const value = this.resolveValue(path, relation.scope, receiver.name);
        if (value.kind === 'unknown') return value;
        return (
          this.methods(value.entry, name, args, (member) => member.static === (value.kind === 'static')) ??
          unknown(value.kind === 'instance' ? 'member-not-found-or-extension-method' : 'member-not-found')
        );
      }
      case 'new': {
        const found = this.resolveType(path, relation.scope, receiver.type);
        if (found.kind !== 'type') return unknown('unknown-receiver-type');
        return this.methods(found.entry, name, args, (member) => !member.static) ?? unknown('member-not-found');
      }
      default:
        return unknown('unknown-receiver-type');
    }
  }
  private reference(path: string, relation: Relation): Target | null {
    if (relation.syntax === 'nameof') {
      // Soft references name a type only when no value with that name is in scope.
      const head = segment(relation.target[0]!).name;
      const { entry } = this.thisType(path, relation.scope);
      if (
        this.local(path, relation.scope, head) ||
        (entry && this.members(entry, head, (member) => member.kind !== 'method').length)
      )
        return null;
      for (let length = relation.target.length; length > 0; length--) {
        const found = this.resolveType(path, relation.scope, relation.target.slice(0, length));
        if (found.kind === 'type') return { kind: 'edges', ids: [found.entry.id], prov: 'binding' };
      }
      return null;
    }
    const found = this.resolveType(path, relation.scope, relation.target, relation.syntax === 'attribute');
    if (found.kind === 'type') return { kind: 'edges', ids: [found.entry.id], prov: 'binding' };
    return found.kind === 'unknown' ? found : null;
  }
  private fileEdge(source: string, to: string, at: [number, number]): void {
    const target = this.symbolFile.get(this.aliases.get(to) ?? to);
    if (!target || source === target) return;
    const key = `${source}\0${target}`;
    const previous = this.fileReferences.get(key);
    if (!previous || at[0] < previous[0] || (at[0] === previous[0] && at[1] < previous[1]))
      this.fileReferences.set(key, at);
  }
  appendRelations(path: string, edges: CodeMapEdge[], unresolved: CodeMapGraph['unresolved'], maxEdges: number): void {
    const record = this.records.get(path)!;
    const csharp = record.csharp!;
    const remap = (id: string) => this.aliases.get(id) ?? id;
    const push = (edge: CodeMapEdge & { at: [number, number] }, source: string) => {
      if (edges.length >= maxEdges) throw new CodeMapLimitError();
      edges.push(edge);
      this.fileEdge(source, edge.to, edge.at);
    };
    for (const type of csharp.types) {
      const entry = this.bySymbol.get(type.symbol);
      if (!entry || entry.parts[0]!.symbol !== type.symbol) continue;
      const bases = this.baseTypes(entry);
      for (const edge of bases?.edges ?? [])
        push({ from: remap(edge.from), to: edge.to, rel: edge.rel, prov: 'binding', at: edge.at }, edge.path);
      for (const entry of bases?.unresolved ?? [])
        unresolved.push({
          from: remap(entry.from),
          rel: 'extends',
          target: entry.target,
          at: entry.at,
          reason: entry.reason,
        });
    }
    for (const relation of csharp.relations) {
      if (unresolved.length >= maxEdges) throw new CodeMapLimitError();
      const target = relation.rel === 'calls' ? this.call(path, relation) : this.reference(path, relation);
      if (!target) continue;
      if (target.kind === 'unknown') {
        const receiver = relation.receiver;
        const prefix =
          !receiver || receiver.kind === 'none'
            ? ''
            : receiver.kind === 'name'
              ? `${receiver.name.join('.')}.`
              : receiver.kind === 'new'
                ? `new ${receiver.type.join('.')}().`
                : receiver.kind === 'expression'
                  ? '<expression>.'
                  : `${receiver.kind}.`;
        unresolved.push({
          from: remap(relation.from),
          rel: relation.rel,
          target: `${prefix}${relation.target.join('.')}`.slice(0, 4096),
          at: relation.at,
          reason: target.reason,
        });
        continue;
      }
      for (const id of target.ids)
        push(
          { from: remap(relation.from), to: remap(id), rel: relation.rel, prov: target.prov, at: relation.at },
          path,
        );
    }
  }
  /** Project and solution groups, their membership and references, and NuGet packages. */
  appendProjects(
    graph: CodeMapGraph,
    paths: readonly string[],
    packages: Map<string, CodeMapGraph['packages'][number]>,
  ): void {
    const counts = new Map<string, number>();
    for (const path of paths) {
      const project = this.projectOf(path);
      if (!project.key) continue;
      counts.set(project.key, (counts.get(project.key) ?? 0) + 1);
      graph.edges.push({ from: `c:${project.key}`, to: `f:${path}`, rel: 'contains', prov: 'binding' });
    }
    const solutionFiles = new Map<string, number>();
    for (const project of this.projects.values()) {
      if (!project.key) continue;
      graph.groups.push({
        id: `c:${project.key}`,
        path: project.directory,
        parent: null,
        files: counts.get(project.key) ?? 0,
        kind: 'project',
        name: project.name,
      });
      for (const reference of project.data?.projectReferences ?? [])
        if (this.projects.has(reference))
          graph.edges.push({ from: `c:${project.key}`, to: `c:${reference}`, rel: 'imports', prov: 'binding' });
        else
          graph.unresolved.push({
            from: `c:${project.key}`,
            rel: 'imports',
            target: reference,
            reason: reference.startsWith('..') ? 'project-outside-checkout' : 'project-not-indexed',
          });
      for (const name of project.data?.packageReferences ?? []) {
        const id = `p:nuget:${name}`;
        packages.set(id, { id, name, external: true, ecosystem: 'nuget' });
        graph.edges.push({ from: `c:${project.key}`, to: id, rel: 'imports', prov: 'binding' });
      }
      for (const solution of project.solutions) {
        solutionFiles.set(solution, (solutionFiles.get(solution) ?? 0) + (counts.get(project.key) ?? 0));
        graph.edges.push({ from: `c:${solution}`, to: `c:${project.key}`, rel: 'contains', prov: 'binding' });
      }
    }
    for (const [path, config] of this.configs)
      if (config.kind === 'dotnet-solution')
        graph.groups.push({
          id: `c:${path}`,
          path: posix.dirname(path),
          parent: null,
          files: solutionFiles.get(path) ?? 0,
          kind: 'solution',
          name: posix.basename(path).replace(/\.slnx?$/i, ''),
        });
  }
  /** File-level dependencies derived from resolved type references, base types and calls. */
  appendFileReferences(edges: CodeMapEdge[]): void {
    for (const [key, at] of [...this.fileReferences].sort(([left], [right]) => comparePaths(left, right))) {
      const [from, to] = key.split('\0') as [string, string];
      edges.push({ from: `f:${from}`, to: `f:${to}`, rel: 'references', prov: 'binding', at });
    }
  }
  /** Effective public visibility: accessible members of public types, after partial declarations merge. */
  exported(symbol: CodeMapSymbol, symbols: ReadonlyMap<string, CodeMapSymbol>, seen = new Set<string>()): boolean {
    const visibility = this.visibility.get(symbol.id) ?? symbol.visibility;
    if (!visibility || !PUBLIC.includes(visibility) || seen.has(symbol.id)) return false;
    seen.add(symbol.id);
    const owner = symbol.owner ? symbols.get(this.aliases.get(symbol.owner) ?? symbol.owner) : undefined;
    return !owner || owner.kind === 'namespace' || this.exported(owner, symbols, seen);
  }
  /** Program entry points: top-level statements and Program/Startup in executable or web projects. */
  entryPoints(): string[] {
    const entries = new Set<string>();
    for (const path of this.paths) {
      const project = this.projectOf(path);
      const executable =
        /^(exe|winexe)$/i.test(project.data?.outputType ?? '') || /\.(web|worker)$/i.test(project.data?.sdk ?? '');
      if (this.records.get(path)!.csharp!.topLevel || (executable && /(^|\/)(Program|Startup)\.cs$/.test(path)))
        entries.add(path);
    }
    return [...entries].sort(comparePaths);
  }
}
