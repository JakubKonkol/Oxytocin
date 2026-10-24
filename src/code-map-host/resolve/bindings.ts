import type { CodeMapEdge, CodeMapGraph, CodeMapSymbol } from '@shared/domain/code-map';
import type { FileRecord, RelationIntent, TypeRef } from '../extract/record';
import type { ModuleResolver } from './modules';
import { CodeMapLimitError } from '../enumerate';

/** What a name or export stands for: never a bare typed value (that is not a graph node). */
type Resolved =
  | { kind: 'symbol'; id: string; typeOnly: boolean; instance?: boolean }
  | { kind: 'namespace'; path: string; typeOnly: boolean }
  | { kind: 'package'; name: string; typeOnly: boolean }
  | { kind: 'unknown'; reason: string };
/** A value whose declared type is `type` (a class, interface, alias or property that owns the members). */
type Target = Resolved | { kind: 'instance'; type: string };
const unknown = (reason: string): Resolved & { kind: 'unknown' } => ({ kind: 'unknown', reason });
const key = (value: Target) =>
  value.kind === 'symbol'
    ? value.id
    : value.kind === 'instance'
      ? `i:${value.type}`
      : value.kind === 'namespace'
        ? value.path
        : value.kind === 'package'
          ? `p:${value.name}`
          : `?:${value.reason}`;
const OWNER_KINDS = ['class', 'interface', 'namespace', 'enum'];
/** Bounds the chain of declared types followed for one receiver (`this.a.b.c`, aliases, return types). */
const TYPE_DEPTH = 24;

/**
 * Records read while resolving one file: indexed files whose content was consulted, and candidate paths whose
 * mere existence decided a module lookup. A result stays valid while none of them changed.
 */
export interface ResolutionDeps {
  paths: Set<string>;
  presence: Set<string>;
  parent: ResolutionDeps | null;
}
const newDeps = (parent: ResolutionDeps | null): ResolutionDeps => ({
  paths: new Set(),
  presence: new Set(),
  parent,
});

export class BindingResolver {
  readonly exportedSymbols = new Set<string>();
  /** The reads of the resolution in progress; `null` while nobody listens. */
  private tracking: ResolutionDeps | null = null;
  private readonly memberPaths = new Map<string, string[]>();
  private readonly exportDeps = new Map<string, ResolutionDeps>();
  private readonly ownerDeps = new Map<string, ResolutionDeps>();
  private readonly symbols = new Map<string, CodeMapSymbol>();
  private readonly scopes = new Map<string, Map<string, FileRecord['scopes'][number]>>();
  private readonly bindings = new Map<string, Map<string, FileRecord['bindings']>>();
  private readonly members = new Map<string, FileRecord['members']>();
  private readonly exports = new Map<string, Resolved>();
  private readonly symbolTypes = new Map<string, { path: string; scope: string; type: TypeRef }>();
  private readonly bases = new Map<string, { path: string; scope: string; target: string[] | null; rel: string }[]>();
  private readonly owners = new Map<string, string>();
  constructor(private readonly modules: ModuleResolver) {
    modules.onProbe = (path) => this.tracking?.presence.add(path);
    for (const [path, record] of modules.records) {
      for (const symbol of record.symbols) this.symbols.set(symbol.id, symbol);
      for (const entry of record.symbolTypes ?? [])
        this.symbolTypes.set(entry.symbol, { path, scope: entry.scope, type: entry.type });
      for (const relation of record.relations)
        if (relation.rel === 'extends' || relation.rel === 'implements') {
          const list = this.bases.get(relation.from) ?? [];
          list.push({ path, scope: relation.scope, target: relation.target, rel: relation.rel });
          this.bases.set(relation.from, list);
        }
      this.scopes.set(path, new Map(record.scopes.map((scope) => [scope.id, scope])));
      const bindings = new Map<string, FileRecord['bindings']>();
      for (const binding of record.bindings) {
        const id = `${binding.scope}\0${binding.name}`;
        const list = bindings.get(id) ?? [];
        list.push(binding);
        bindings.set(id, list);
      }
      this.bindings.set(path, bindings);
      for (const member of record.members) {
        const list = this.members.get(member.owner) ?? [];
        list.push(member);
        this.members.set(member.owner, list);
        const paths = this.memberPaths.get(member.owner);
        if (!paths) this.memberPaths.set(member.owner, [path]);
        else if (paths.at(-1) !== path) paths.push(path);
      }
    }
  }
  /** Runs the resolution of one file and returns everything it read. */
  track<T>(run: () => T): { value: T; deps: ResolutionDeps } {
    const deps = newDeps(null);
    this.tracking = deps;
    try {
      return { value: run(), deps };
    } finally {
      this.tracking = null;
    }
  }
  private read(path: string): void {
    this.tracking?.paths.add(path);
  }
  /** The file a symbol id belongs to: ids are `s:<path>#...`; a deleted file's ids still name their path. */
  private readId(id: string): void {
    if (!this.tracking) return;
    const known = this.symbols.get(id);
    if (known) {
      this.tracking.paths.add(known.file.slice(2));
      return;
    }
    for (let index = id.indexOf('#'); index > 2; index = id.indexOf('#', index + 1))
      this.tracking.paths.add(id.slice(2, index));
  }
  private absorb(deps: ResolutionDeps | undefined): void {
    if (!this.tracking || !deps) return;
    for (const path of deps.paths) this.tracking.paths.add(path);
    for (const path of deps.presence) this.tracking.presence.add(path);
  }
  /** Collects the reads of a cached computation so that a later cache hit can report them too. */
  private memoized<T>(run: () => T): { value: T; deps: ResolutionDeps } {
    const outer = this.tracking;
    const deps = newDeps(outer);
    this.tracking = deps;
    try {
      return { value: run(), deps };
    } finally {
      this.tracking = outer;
      if (outer) this.absorbInto(outer, deps);
    }
  }
  private absorbInto(target: ResolutionDeps, deps: ResolutionDeps): void {
    for (const path of deps.paths) target.paths.add(path);
    for (const path of deps.presence) target.presence.add(path);
  }
  private sym(id: string): CodeMapSymbol | undefined {
    this.readId(id);
    return this.symbols.get(id);
  }
  private symType(id: string): { path: string; scope: string; type: TypeRef } | undefined {
    this.readId(id);
    return this.symbolTypes.get(id);
  }
  private memberList(owner: string): FileRecord['members'] {
    if (this.tracking) {
      this.readId(owner);
      for (const path of this.memberPaths.get(owner) ?? []) this.tracking.paths.add(path);
    }
    return this.members.get(owner) ?? [];
  }
  private baseList(owner: string): { path: string; scope: string; target: string[] | null; rel: string }[] {
    this.readId(owner);
    const list = this.bases.get(owner) ?? [];
    for (const base of list) this.read(base.path);
    return list;
  }
  private local(path: string, scope: string, name: string): FileRecord['bindings'] | null {
    this.read(path);
    const scopes = this.scopes.get(path);
    for (let current: string | null = scope; current; current = scopes?.get(current)?.parent ?? null) {
      const binding = this.bindings.get(path)?.get(`${current}\0${name}`);
      if (binding) return binding;
    }
    return null;
  }
  private imported(path: string, module: string, name: string, typeOnly: boolean, visiting: Set<string>): Resolved {
    const resolved = this.modules.resolve(path, module);
    if (resolved.kind === 'unresolved') return unknown(resolved.reason);
    if (resolved.kind === 'package') return { ...resolved, typeOnly };
    if (name === '*') return { kind: 'namespace', path: resolved.path, typeOnly };
    const target = this.exported(resolved.path, name, visiting);
    return target.kind === 'unknown' ? target : { ...target, typeOnly: typeOnly || target.typeOnly };
  }
  private binding(path: string, scope: string, name: string, visiting: Set<string>): Target {
    const marker = `binding:${path}:${scope}:${name}`;
    if (visiting.has(marker) || visiting.size > 100) return unknown('cyclic-or-deep-binding');
    visiting = new Set(visiting).add(marker);
    let candidates = this.local(path, scope, name);
    if (!candidates) return unknown('unbound-name');
    if (candidates.some((binding) => binding.implementation))
      candidates = candidates.filter((binding) => binding.implementation);
    if (candidates.length !== 1) return unknown('ambiguous-binding');
    const binding = candidates[0]!;
    if (binding.imported) {
      if (binding.imported.require && this.local(path, scope, 'require')) return unknown('shadowed-require');
      return this.imported(path, binding.imported.module, binding.imported.name, binding.imported.typeOnly, visiting);
    }
    if (binding.symbol) return { kind: 'symbol', id: binding.symbol, typeOnly: false };
    const type = binding.type ? this.owner(path, binding.scope, binding.type, visiting) : null;
    return type ? { kind: 'instance', type } : unknown('unknown-value-type');
  }
  private unique(targets: Resolved[]): Resolved {
    const matches = [
      ...new Map(targets.filter((target) => target.kind !== 'unknown').map((target) => [key(target), target])).values(),
    ];
    return matches.length === 1 ? matches[0]! : unknown(matches.length ? 'ambiguous-export' : 'export-not-found');
  }
  private exported(path: string, name: string, visiting: Set<string>): Resolved {
    const marker = `export:${path}:${name}`;
    const cached = this.exports.get(marker);
    if (cached) {
      this.absorb(this.exportDeps.get(marker));
      return cached;
    }
    if (visiting.has(marker) || visiting.size > 100) return unknown('cyclic-or-deep-export');
    visiting = new Set(visiting).add(marker);
    const { value: result, deps } = this.memoized(() => this.computeExport(path, name, visiting));
    if (result.kind !== 'unknown') {
      this.exports.set(marker, result);
      this.exportDeps.set(marker, deps);
    }
    return result;
  }
  private computeExport(path: string, name: string, visiting: Set<string>): Resolved {
    this.read(path);
    const record = this.modules.records.get(path);
    if (!record) return unknown('module-not-indexed');
    const explicit = record.exports.filter((entry) => entry.name === name);
    const choices = explicit.length
      ? explicit
      : name === 'default'
        ? []
        : record.exports.filter((entry) => entry.name === '*');
    const targets = choices.map((entry): Resolved => {
      if (entry.symbol) return { kind: 'symbol', id: entry.symbol, typeOnly: entry.typeOnly };
      if (entry.local) {
        const local = this.binding(path, 'file', entry.local, visiting);
        return local.kind === 'instance' ? unknown('unknown-value-type') : local;
      }
      if (entry.module)
        return this.imported(
          path,
          entry.module,
          entry.name === '*' ? name : (entry.imported ?? name),
          entry.typeOnly,
          visiting,
        );
      return unknown('export-not-found');
    });
    return this.unique(targets);
  }
  /** The class, interface, alias or property whose members describe values of the declared type `ref`. */
  private owner(path: string, scope: string, ref: TypeRef, visiting: Set<string>): string | null {
    if ('shape' in ref || visiting.size > TYPE_DEPTH) return null;
    const cacheKey = `${path}\0${scope}\0${JSON.stringify(ref)}`;
    const cached = this.owners.get(cacheKey);
    if (cached) {
      this.absorb(this.ownerDeps.get(cacheKey));
      return cached;
    }
    const { value: result, deps } = this.memoized(() => this.computeOwner(path, scope, ref, visiting));
    if (result) {
      this.owners.set(cacheKey, result);
      this.ownerDeps.set(cacheKey, deps);
    }
    return result;
  }
  private computeOwner(
    path: string,
    scope: string,
    ref: Exclude<TypeRef, { shape: true }>,
    visiting: Set<string>,
  ): string | null {
    let result: string | null = null;
    if ('name' in ref) {
      // `Promise<T>` is a promise, not a `T`; only `await` unwraps it (see `call` below).
      // A utility wrapper only counts when the name is not declared by the project itself.
      const shadowed = (ref.wrappers ?? []).some((name) => {
        const wrapper = this.evaluate(path, scope, [name], visiting);
        return wrapper.kind !== 'unknown' || wrapper.reason !== 'unbound-name';
      });
      const value = ref.promise || shadowed ? unknown('promise') : this.evaluate(path, scope, ref.name, visiting);
      if (value.kind === 'symbol' && !value.instance) result = this.typeOwner(value.id, visiting);
    } else if ('value' in ref) {
      const value = this.evaluate(path, scope, ref.value, visiting);
      if (value.kind === 'instance') result = value.type;
      else if (value.kind === 'symbol' && !value.instance) {
        const kind = this.sym(value.id)?.kind;
        if (kind === 'property' || kind === 'variable') result = this.valueOwner(value.id, visiting);
      }
    } else {
      const callee = this.evaluate(path, scope, ref.call, visiting);
      const kind = callee.kind === 'symbol' ? this.sym(callee.id)?.kind : undefined;
      const declared = callee.kind === 'symbol' ? this.symType(callee.id) : undefined;
      if (declared && 'name' in declared.type && (kind === 'function' || kind === 'method' || kind === 'component'))
        if (!declared.type.promise || ref.await)
          result = this.owner(
            declared.path,
            declared.scope,
            { name: declared.type.name, ...(declared.type.wrappers ? { wrappers: declared.type.wrappers } : {}) },
            visiting,
          );
    }
    return result;
  }
  /** A type symbol as the owner of its instances' members; aliases are followed to what they name. */
  private typeOwner(id: string, visiting: Set<string>): string | null {
    const kind = this.sym(id)?.kind;
    if (kind === 'class' || kind === 'interface') return id;
    if (kind !== 'type') return null;
    const marker = `type:${id}`;
    const declared = this.symType(id);
    if (!declared || visiting.has(marker)) return null;
    if ('shape' in declared.type) return id;
    return this.owner(declared.path, declared.scope, declared.type, new Set(visiting).add(marker));
  }
  /** The owner of the members of a property or exported variable, from its declared type. */
  private valueOwner(id: string, visiting: Set<string>): string | null {
    const declared = this.symType(id);
    if (!declared) return null;
    if ('shape' in declared.type) return this.sym(id)?.kind === 'property' ? id : null;
    const marker = `value:${id}`;
    if (visiting.has(marker)) return null;
    return this.owner(declared.path, declared.scope, declared.type, new Set(visiting).add(marker));
  }
  /** Members named `name` of `ownerId` and of what it extends; `blocked` when a base type is not indexed. */
  private collect(
    ownerId: string,
    name: string,
    instance: boolean,
    visiting: Set<string>,
  ): { symbols: Set<string>; blocked: boolean; ambiguous: boolean } {
    const found = { symbols: new Set<string>(), blocked: false, ambiguous: false };
    const owner = this.sym(ownerId);
    if (!owner) return { ...found, blocked: true };
    const keepsStatics = owner.kind === 'namespace' || owner.kind === 'enum';
    let members = this.memberList(ownerId).filter(
      (member) => member.name === name && (keepsStatics || member.static === !instance),
    );
    // Anonymous object types (`deps: { run(): void }`) have no implementation to prefer over their signatures.
    if (owner.kind !== 'property' && members.some((member) => member.implementation))
      members = members.filter((member) => member.implementation);
    if (members.length) {
      for (const member of members) found.symbols.add(member.symbol);
      found.ambiguous = members.length > 1;
      return found;
    }
    const marker = `members:${ownerId}`;
    if ((owner.kind !== 'class' && owner.kind !== 'interface') || visiting.has(marker) || visiting.size > TYPE_DEPTH)
      return found;
    const inner = new Set(visiting).add(marker);
    const bases = this.baseList(ownerId);
    const baseOwner = (base: (typeof bases)[number]): string | null => {
      const value = base.target ? this.evaluate(base.path, base.scope, base.target, inner) : null;
      const id = value?.kind === 'symbol' && !value.instance ? value.id : null;
      const kind = id ? this.sym(id)?.kind : undefined;
      return kind === 'class' || kind === 'interface' ? id : null;
    };
    const merge = (list: typeof bases, strict: boolean): void => {
      for (const base of list) {
        const id = baseOwner(base);
        if (!id) {
          if (strict) found.blocked = true;
          continue;
        }
        const next = this.collect(id, name, instance, inner);
        for (const symbol of next.symbols) found.symbols.add(symbol);
        found.blocked ||= next.blocked;
        found.ambiguous ||= next.ambiguous;
      }
    };
    merge(
      bases.filter((base) => base.rel === 'extends'),
      true,
    );
    // A class that neither declares nor inherits the member may still get it from an interface it implements
    // (abstract classes); an unindexed interface does not hide an implementation, so it does not block.
    if (!found.symbols.size && !found.blocked)
      merge(
        bases.filter((base) => base.rel === 'implements'),
        false,
      );
    return found;
  }
  private member(value: Target, name: string, visiting: Set<string>): Target {
    if (value.kind === 'unknown' || value.kind === 'package') return value;
    if (value.kind === 'namespace') {
      const next = this.exported(value.path, name, visiting);
      return next.kind === 'unknown' ? next : { ...next, typeOnly: next.typeOnly || value.typeOnly };
    }
    let ownerId: string | null;
    let instance = true;
    let typeOnly = false;
    if (value.kind === 'instance') {
      ownerId = value.type;
    } else {
      const kind = this.sym(value.id)?.kind ?? '';
      typeOnly = value.typeOnly;
      if (OWNER_KINDS.includes(kind)) {
        ownerId = value.id;
        instance = value.instance ?? false;
      } else ownerId = kind === 'property' || kind === 'variable' ? this.valueOwner(value.id, visiting) : null;
    }
    if (!ownerId) return unknown('unknown-member-receiver-type');
    const found = this.collect(ownerId, name, instance, visiting);
    if (found.symbols.size === 1 && !found.blocked && !found.ambiguous)
      return { kind: 'symbol', id: [...found.symbols][0]!, typeOnly };
    return unknown(found.ambiguous || found.symbols.size > 1 ? 'ambiguous-member' : 'member-not-resolved');
  }
  /** Follows `names` (`a`, `this.a.b`, `ns.T`) from `scope`: bindings, then members, through declared types. */
  private evaluate(path: string, scope: string, names: string[], visiting: Set<string>): Target {
    const [name, ...members] = names;
    this.read(path);
    const info = this.scopes.get(path)?.get(scope);
    let value: Target =
      name === 'this'
        ? info?.thisClass
          ? { kind: 'symbol', id: info.thisClass, typeOnly: false, instance: !info.staticThis }
          : unknown('dynamic-this')
        : this.binding(path, scope, name!, visiting);
    for (const member of members) value = this.member(value, member, visiting);
    return value;
  }
  resolve(path: string, relation: RelationIntent): Resolved {
    const target = relation.target;
    if (!target?.length) return unknown('dynamic-or-computed-expression');
    const evaluated = this.evaluate(path, relation.scope, target, new Set());
    // A typed value is not a symbol; keep the reason a plain value had before declared types were followed.
    const value: Resolved = evaluated.kind === 'instance' ? unknown('unknown-value-type') : evaluated;
    if (relation.rel === 'calls') {
      if (value.kind !== 'unknown' && value.typeOnly) return unknown('type-only-import');
      if (value.kind === 'namespace') return unknown('namespace-is-not-callable');
      if (
        value.kind === 'symbol' &&
        !['function', 'component', 'method', 'class'].includes(this.sym(value.id)?.kind ?? '')
      )
        return unknown('unknown-callable-value');
    }
    return value;
  }
  appendRelations(
    path: string,
    edges: CodeMapEdge[],
    unresolved: CodeMapGraph['unresolved'],
    packages: Set<string>,
    maxEdges = 2_000_000,
    exportedOut?: string[],
  ): void {
    this.read(path);
    const record = this.modules.records.get(path)!;
    for (const intent of record.imports) {
      if (edges.length >= maxEdges || unresolved.length >= maxEdges) throw new CodeMapLimitError();
      if (intent.kind === 'require' && this.local(path, intent.scope, 'require')) continue;
      const target = this.modules.resolve(path, intent.module);
      if (target.kind === 'unresolved')
        unresolved.push({
          from: record.file.id,
          rel: 'imports',
          target: intent.module ?? '<dynamic>',
          at: intent.at,
          reason: target.reason,
        });
      else {
        if (target.kind === 'package') packages.add(target.name);
        edges.push({
          from: record.file.id,
          to: target.kind === 'file' ? `f:${target.path}` : `p:${target.name}`,
          rel: intent.kind === 'export' ? 'exports' : 'imports',
          prov: 'binding',
          typeOnly: intent.typeOnly,
          at: intent.at,
        });
      }
    }
    for (const entry of record.exports) {
      if (entry.name === '*') continue;
      const target = this.exported(path, entry.name, new Set());
      if (target.kind !== 'symbol') continue;
      if (edges.length >= maxEdges) throw new CodeMapLimitError();
      const symbol = this.sym(target.id);
      if (symbol?.file === record.file.id) this.exportedSymbols.add(target.id);
      if (symbol?.file === record.file.id) exportedOut?.push(target.id);
      edges.push({
        from: record.file.id,
        to: target.id,
        rel: 'exports',
        prov: 'binding',
        typeOnly: entry.typeOnly || target.typeOnly,
        ...(symbol?.file === record.file.id ? { at: [symbol.span[0], symbol.span[1]] as [number, number] } : {}),
      });
    }
    for (const relation of record.relations) {
      if (edges.length >= maxEdges || unresolved.length >= maxEdges) throw new CodeMapLimitError();
      if (
        relation.target?.length === 1 &&
        relation.target[0] === 'require' &&
        !this.local(path, relation.scope, 'require')
      )
        continue;
      const target = this.resolve(path, relation);
      if (target.kind === 'unknown' || target.kind === 'namespace') {
        unresolved.push({
          from: relation.from,
          rel: relation.rel,
          target: relation.target?.join('.') ?? '<dynamic>',
          at: relation.at,
          reason: target.kind === 'unknown' ? target.reason : 'namespace-reference',
        });
      } else {
        if (target.kind === 'package') packages.add(target.name);
        edges.push({
          from: relation.from,
          to: target.kind === 'symbol' ? target.id : `p:${target.name}`,
          rel: relation.rel,
          prov: 'binding',
          typeOnly: target.typeOnly,
          at: relation.at,
        });
      }
    }
  }
}
