import type { CodeMapEdge, CodeMapGraph } from '@shared/domain/code-map';
import type { FileRecord } from '../extract/record';
import type { ProjectConfig } from '../resolve/config';
import type { ResolutionDeps } from '../resolve/bindings';
import { BindingIndex, type FacetKind } from '../resolve/binding-index';

/** A slice of another file's record that a resolution read, with the signature it had then. */
interface RecordedFacet {
  kind: FacetKind;
  a: string;
  b: string;
  /** Files whose records can change this facet. */
  paths: string[];
  signature: string;
}

/** What resolving one file produced, and exactly what the result depended on. */
export interface FileResolution {
  record: FileRecord;
  /** Records of the files the facets belong to, as they were; an unchanged record cannot change a facet. */
  deps: Map<string, FileRecord | undefined>;
  facets: RecordedFacet[];
  /** Candidate module paths whose existence decided a lookup. */
  presence: Map<string, boolean>;
  edges: CodeMapEdge[];
  unresolved: CodeMapGraph['unresolved'];
  packages: string[];
  exported: string[];
}

/**
 * Per-file relation resolution reused across builds. A file's relations are a pure function of its own record, the
 * facets of other records it reads while following imports, re-exports and declared types, the existence of the
 * module paths it probed, and the project configuration. An entry is reused only while every one of those is
 * unchanged, so the graph equals a full build; any change to the configuration discards everything.
 */
export class ResolutionCache {
  readonly index = new BindingIndex();
  private entries = new Map<string, FileResolution>();
  private configs: ReadonlyMap<string, ProjectConfig> = new Map();
  private records: ReadonlyMap<string, FileRecord> = new Map();

  /** Prepares a build: drops entries of removed files, and all entries when the project configuration changed. */
  begin(records: ReadonlyMap<string, FileRecord>, configs: ReadonlyMap<string, ProjectConfig>): void {
    let same = configs.size === this.configs.size;
    if (same) for (const [path, config] of configs) if (this.configs.get(path) !== config) same = false;
    if (!same) this.entries.clear();
    this.configs = new Map(configs);
    this.records = records;
    this.index.update(records);
    for (const path of this.entries.keys()) if (!records.has(path)) this.entries.delete(path);
  }
  lookup(path: string): FileResolution | undefined {
    const records = this.records;
    const entry = this.entries.get(path);
    if (!entry || entry.record !== records.get(path)) return undefined;
    for (const [candidate, present] of entry.presence) if (records.has(candidate) !== present) return undefined;
    let changed: Set<string> | undefined;
    for (const [dep, record] of entry.deps) if (records.get(dep) !== record) (changed ??= new Set()).add(dep);
    if (changed) {
      for (const facet of entry.facets)
        if (
          facet.paths.some((dep) => changed.has(dep)) &&
          this.index.signature(facet.kind, facet.a, facet.b, records) !== facet.signature
        )
          return undefined;
      for (const dep of changed) entry.deps.set(dep, records.get(dep));
    }
    return entry;
  }
  store(
    path: string,
    deps: ResolutionDeps,
    output: Pick<FileResolution, 'edges' | 'unresolved' | 'packages' | 'exported'>,
  ): FileResolution {
    const records = this.records;
    const facets: RecordedFacet[] = [];
    const watched = new Map<string, FileRecord | undefined>();
    for (const encoded of deps.facets) {
      const first = encoded.indexOf('\0'),
        second = encoded.indexOf('\0', first + 1);
      const kind = encoded.slice(0, first) as FacetKind,
        a = encoded.slice(first + 1, second),
        b = encoded.slice(second + 1);
      const paths = this.index.paths(kind, a);
      for (const dep of paths) watched.set(dep, records.get(dep));
      facets.push({ kind, a, b, paths, signature: this.index.signature(kind, a, b, records) });
    }
    const entry: FileResolution = {
      record: records.get(path)!,
      deps: watched,
      facets,
      presence: new Map([...deps.presence].map((candidate) => [candidate, records.has(candidate)])),
      ...output,
    };
    this.entries.set(path, entry);
    return entry;
  }
  clear(): void {
    this.entries.clear();
    this.index.clear();
    this.records = new Map();
  }
}
