import type { CodeMapSymbol } from '@shared/domain/code-map';
import type { FileRecord, Scope, TypeRef } from '../extract/record';

type Binding = FileRecord['bindings'][number];
type Member = FileRecord['members'][number];
export interface Base {
  path: string;
  scope: string;
  target: string[] | null;
  rel: string;
}
export interface SymbolType {
  path: string;
  scope: string;
  type: TypeRef;
}

/**
 * Facets are the slices of other files' records that a resolution can read. A cached resolution stays valid while
 * the signature of every facet it read is unchanged, so an edit that only moves code or adds an unrelated export
 * does not make importers resolve again.
 * - `x`: the export entries of module `a` that answer the name `b`
 * - `l`: the bindings visible in file `a` for `b` = `scope \0 name`, with the scope chain searched
 * - `c`: the scope `b` of file `a`
 * - `s`: kind and file of symbol `a`;  `t`: declared type of symbol `a`
 * - `m`: members named `b` of owner `a`;  `b`: base types of owner `a`
 */
export type FacetKind = 'x' | 'l' | 'c' | 's' | 't' | 'm' | 'b';
export const encodeFacet = (kind: FacetKind, a: string, b = ''): string => `${kind}\0${a}\0${b}`;

/**
 * Lookup tables over all records of one build: symbols, scopes, bindings, members, declared types and base types.
 * They are maintained by record identity, so a build only pays for the records that changed.
 */
export class BindingIndex {
  readonly symbols = new Map<string, CodeMapSymbol>();
  readonly scopes = new Map<string, Map<string, Scope>>();
  readonly bindings = new Map<string, Map<string, Binding[]>>();
  readonly members = new Map<string, Member[]>();
  readonly symbolTypes = new Map<string, SymbolType>();
  readonly bases = new Map<string, Base[]>();
  private readonly indexed = new Map<string, FileRecord>();

  /** Brings the tables up to date with `records`. */
  update(records: ReadonlyMap<string, FileRecord>): void {
    for (const [path, old] of this.indexed)
      if (records.get(path) !== old) {
        this.remove(path, old);
        this.indexed.delete(path);
      }
    for (const [path, record] of records)
      if (this.indexed.get(path) !== record) {
        this.add(path, record);
        this.indexed.set(path, record);
      }
  }
  clear(): void {
    this.symbols.clear();
    this.scopes.clear();
    this.bindings.clear();
    this.members.clear();
    this.symbolTypes.clear();
    this.bases.clear();
    this.indexed.clear();
  }
  private add(path: string, record: FileRecord): void {
    for (const symbol of record.symbols) this.symbols.set(symbol.id, symbol);
    for (const entry of record.symbolTypes ?? [])
      this.symbolTypes.set(entry.symbol, { path, scope: entry.scope, type: entry.type });
    for (const relation of record.relations)
      if (relation.rel === 'extends' || relation.rel === 'implements') {
        const list = this.bases.get(relation.from);
        const base = { path, scope: relation.scope, target: relation.target, rel: relation.rel };
        if (list) list.push(base);
        else this.bases.set(relation.from, [base]);
      }
    this.scopes.set(path, new Map(record.scopes.map((scope) => [scope.id, scope])));
    const bindings = new Map<string, Binding[]>();
    for (const binding of record.bindings) {
      const id = `${binding.scope}\0${binding.name}`;
      const list = bindings.get(id);
      if (list) list.push(binding);
      else bindings.set(id, [binding]);
    }
    this.bindings.set(path, bindings);
    for (const member of record.members) {
      const list = this.members.get(member.owner);
      if (list) list.push(member);
      else this.members.set(member.owner, [member]);
    }
  }
  private remove(path: string, record: FileRecord): void {
    for (const symbol of record.symbols) if (this.symbols.get(symbol.id) === symbol) this.symbols.delete(symbol.id);
    for (const entry of record.symbolTypes ?? [])
      if (this.symbolTypes.get(entry.symbol)?.path === path) this.symbolTypes.delete(entry.symbol);
    for (const relation of record.relations)
      if (relation.rel === 'extends' || relation.rel === 'implements') {
        const list = this.bases.get(relation.from)?.filter((base) => base.path !== path);
        if (list?.length) this.bases.set(relation.from, list);
        else this.bases.delete(relation.from);
      }
    this.scopes.delete(path);
    this.bindings.delete(path);
    const removed = new Set(record.members);
    for (const owner of new Set(record.members.map((member) => member.owner))) {
      const list = this.members.get(owner)?.filter((member) => !removed.has(member));
      if (list?.length) this.members.set(owner, list);
      else this.members.delete(owner);
    }
  }

  /** The bindings of `name` visible from `scope` (innermost scope wins) and the scopes searched. */
  local(path: string, scope: string, name: string): { found: Binding[] | null; chain: string[] } {
    const scopes = this.scopes.get(path);
    const chain: string[] = [];
    for (let current: string | null = scope; current; current = scopes?.get(current)?.parent ?? null) {
      chain.push(current);
      const found = this.bindings.get(path)?.get(`${current}\0${name}`);
      if (found) return { found, chain };
    }
    return { found: null, chain };
  }
  /** The files whose records can change what a facet reads. */
  paths(kind: FacetKind, a: string): string[] {
    if (kind === 'x' || kind === 'l' || kind === 'c') return [a];
    const known = this.symbols.get(a);
    if (known) return [known.file.slice(2)];
    // Symbol ids are `s:<path>#...`; a missing symbol may come back with any path that prefixes the id.
    const paths: string[] = [];
    for (let index = a.indexOf('#'); index > 2; index = a.indexOf('#', index + 1)) paths.push(a.slice(2, index));
    return paths;
  }
  /** A string that changes exactly when the facet's content changes. */
  signature(kind: FacetKind, a: string, b: string, records: ReadonlyMap<string, FileRecord>): string {
    switch (kind) {
      case 'x': {
        const record = records.get(a);
        if (!record) return '-';
        const explicit = record.exports.filter((entry) => entry.name === b);
        return JSON.stringify(
          explicit.length ? explicit : b === 'default' ? [] : record.exports.filter((entry) => entry.name === '*'),
        );
      }
      case 'l': {
        const split = b.indexOf('\0');
        return JSON.stringify(this.local(a, b.slice(0, split), b.slice(split + 1)));
      }
      case 'c':
        return JSON.stringify(this.scopes.get(a)?.get(b) ?? null);
      case 's': {
        const symbol = this.symbols.get(a);
        return symbol ? `${symbol.kind}\0${symbol.file}` : '-';
      }
      case 't':
        return JSON.stringify(this.symbolTypes.get(a) ?? null);
      case 'm':
        return JSON.stringify(this.members.get(a)?.filter((member) => member.name === b) ?? []);
      case 'b':
        return JSON.stringify(this.bases.get(a) ?? []);
    }
  }
}
