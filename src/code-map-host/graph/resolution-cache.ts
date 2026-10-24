import type { CodeMapEdge, CodeMapGraph } from '@shared/domain/code-map';
import type { FileRecord } from '../extract/record';
import type { ProjectConfig } from '../resolve/config';
import type { ResolutionDeps } from '../resolve/bindings';

/** What resolving one file produced, and exactly what the result depended on. */
export interface FileResolution {
  record: FileRecord;
  /** Records the resolution consulted, by identity (`undefined`: the file was not indexed). */
  deps: Map<string, FileRecord | undefined>;
  /** Candidate module paths whose existence decided a lookup. */
  presence: Map<string, boolean>;
  edges: CodeMapEdge[];
  unresolved: CodeMapGraph['unresolved'];
  packages: string[];
  exported: string[];
}

/**
 * Per-file relation resolution reused across builds. A file's relations are a pure function of its own record, the
 * records it reads while following imports, re-exports and declared types, the existence of the module paths it
 * probed, and the project configuration. An entry is reused only while every one of those is unchanged, so the
 * graph equals a full build; any change to the configuration discards everything.
 */
export class ResolutionCache {
  private entries = new Map<string, FileResolution>();
  private configs: ReadonlyMap<string, ProjectConfig> = new Map();

  /** Prepares a build: drops entries of removed files, and all entries when the project configuration changed. */
  begin(records: ReadonlyMap<string, FileRecord>, configs: ReadonlyMap<string, ProjectConfig>): void {
    let same = configs.size === this.configs.size;
    if (same) for (const [path, config] of configs) if (this.configs.get(path) !== config) same = false;
    if (!same) this.entries.clear();
    this.configs = new Map(configs);
    for (const path of this.entries.keys()) if (!records.has(path)) this.entries.delete(path);
  }
  lookup(path: string, records: ReadonlyMap<string, FileRecord>): FileResolution | undefined {
    const entry = this.entries.get(path);
    if (!entry || entry.record !== records.get(path)) return undefined;
    for (const [dep, record] of entry.deps) if (records.get(dep) !== record) return undefined;
    for (const [candidate, present] of entry.presence) if (records.has(candidate) !== present) return undefined;
    return entry;
  }
  store(
    path: string,
    records: ReadonlyMap<string, FileRecord>,
    deps: ResolutionDeps,
    output: Pick<FileResolution, 'edges' | 'unresolved' | 'packages' | 'exported'>,
  ): FileResolution {
    const entry: FileResolution = {
      record: records.get(path)!,
      deps: new Map([...deps.paths].map((dep) => [dep, records.get(dep)])),
      presence: new Map([...deps.presence].map((candidate) => [candidate, records.has(candidate)])),
      ...output,
    };
    this.entries.set(path, entry);
    return entry;
  }
  clear(): void {
    this.entries.clear();
  }
}
