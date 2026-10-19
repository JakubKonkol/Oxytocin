import type { CodeMapEdge, CodeMapGraph, CodeMapSymbol } from '@shared/domain/code-map';
import type { FileRecord, RelationIntent } from '../extract/record';
import type { ModuleResolver } from './modules';
import { CodeMapLimitError } from '../enumerate';

type Target =
  | { kind: 'symbol'; id: string; typeOnly: boolean }
  | { kind: 'namespace'; path: string; typeOnly: boolean }
  | { kind: 'package'; name: string; typeOnly: boolean }
  | { kind: 'unknown'; reason: string };
const unknown = (reason: string): Target => ({ kind: 'unknown', reason });
const key = (value: Target) =>
  value.kind === 'symbol'
    ? value.id
    : value.kind === 'namespace'
      ? value.path
      : value.kind === 'package'
        ? `p:${value.name}`
        : `?:${value.reason}`;

export class BindingResolver {
  readonly exportedSymbols = new Set<string>();
  private readonly symbols = new Map<string, CodeMapSymbol>();
  private readonly scopes = new Map<string, Map<string, FileRecord['scopes'][number]>>();
  private readonly bindings = new Map<string, Map<string, FileRecord['bindings']>>();
  private readonly members = new Map<string, FileRecord['members']>();
  private readonly exports = new Map<string, Target>();
  constructor(private readonly modules: ModuleResolver) {
    for (const [path, record] of modules.records) {
      for (const symbol of record.symbols) this.symbols.set(symbol.id, symbol);
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
      }
    }
  }
  private local(path: string, scope: string, name: string): FileRecord['bindings'] | null {
    const scopes = this.scopes.get(path);
    for (let current: string | null = scope; current; current = scopes?.get(current)?.parent ?? null) {
      const binding = this.bindings.get(path)?.get(`${current}\0${name}`);
      if (binding) return binding;
    }
    return null;
  }
  private imported(path: string, module: string, name: string, typeOnly: boolean, visiting: Set<string>): Target {
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
    return binding.symbol ? { kind: 'symbol', id: binding.symbol, typeOnly: false } : unknown('unknown-value-type');
  }
  private unique(targets: Target[]): Target {
    const matches = [
      ...new Map(targets.filter((target) => target.kind !== 'unknown').map((target) => [key(target), target])).values(),
    ];
    return matches.length === 1 ? matches[0]! : unknown(matches.length ? 'ambiguous-export' : 'export-not-found');
  }
  private exported(path: string, name: string, visiting: Set<string>): Target {
    const marker = `export:${path}:${name}`;
    const cached = this.exports.get(marker);
    if (cached) return cached;
    if (visiting.has(marker) || visiting.size > 100) return unknown('cyclic-or-deep-export');
    visiting = new Set(visiting).add(marker);
    const record = this.modules.records.get(path);
    if (!record) return unknown('module-not-indexed');
    const explicit = record.exports.filter((entry) => entry.name === name);
    const choices = explicit.length
      ? explicit
      : name === 'default'
        ? []
        : record.exports.filter((entry) => entry.name === '*');
    const targets = choices.map((entry): Target => {
      if (entry.symbol) return { kind: 'symbol', id: entry.symbol, typeOnly: entry.typeOnly };
      if (entry.local) return this.binding(path, 'file', entry.local, visiting);
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
    const result = this.unique(targets);
    if (result.kind !== 'unknown') this.exports.set(marker, result);
    return result;
  }
  private member(value: Target, name: string, instance: boolean, visiting: Set<string>): Target {
    if (value.kind === 'unknown' || value.kind === 'package') return value;
    if (value.kind === 'namespace') {
      const next = this.exported(value.path, name, visiting);
      return next.kind === 'unknown' ? next : { ...next, typeOnly: next.typeOnly || value.typeOnly };
    }
    const owner = this.symbols.get(value.id);
    if (!owner || !['class', 'interface', 'namespace', 'enum'].includes(owner.kind))
      return unknown('unknown-member-receiver-type');
    let members = (this.members.get(value.id) ?? []).filter(
      (member) =>
        member.name === name && (owner.kind === 'namespace' || owner.kind === 'enum' || member.static === !instance),
    );
    if (members.some((member) => member.implementation)) members = members.filter((member) => member.implementation);
    return members.length === 1
      ? { kind: 'symbol', id: members[0]!.symbol, typeOnly: value.typeOnly }
      : unknown(members.length ? 'ambiguous-member' : 'member-not-resolved');
  }
  resolve(path: string, relation: RelationIntent): Target {
    const target = relation.target;
    if (!target?.length) return unknown('dynamic-or-computed-expression');
    const [name, ...members] = target;
    const scope = this.scopes.get(path)?.get(relation.scope);
    let value: Target =
      name === 'this'
        ? scope?.thisClass
          ? { kind: 'symbol', id: scope.thisClass, typeOnly: false }
          : unknown('dynamic-this')
        : this.binding(path, relation.scope, name!, new Set());
    for (const member of members) value = this.member(value, member, name === 'this' && !scope?.staticThis, new Set());
    if (relation.rel === 'calls') {
      if (value.kind !== 'unknown' && value.typeOnly) return unknown('type-only-import');
      if (value.kind === 'namespace') return unknown('namespace-is-not-callable');
      if (
        value.kind === 'symbol' &&
        !['function', 'component', 'method', 'class'].includes(this.symbols.get(value.id)?.kind ?? '')
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
  ): void {
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
      const symbol = this.symbols.get(target.id);
      if (symbol?.file === record.file.id) this.exportedSymbols.add(target.id);
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
