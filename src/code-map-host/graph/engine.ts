import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CODE_MAP_LIMITS,
  CodeMapManifestSchema,
  type CodeMapDiagnostics,
  type CodeMapGraph,
  type CodeMapManifest,
} from '@shared/domain/code-map';
import { GrammarManifestSchema } from '@shared/domain/code-map-grammars';
import { CodeMapLimitError, comparePaths } from '../enumerate';
import { EXTRACTOR_VERSION, FileRecordSchema, type FileRecord } from '../extract/record';
import { fileRecord, normalizedSource } from '../extract/files';
import { buildSearchData } from '../extract/search-data';
import { parserLanguage } from '../extract/languages';
import type { ParserClient } from '../parse/client';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { renderMapMarkdown } from '../map-md';
import { atomicWrite, CacheStore, loadSnapshot, publishSnapshot, sha256 } from '../store/writer';
import { safeDirectory } from '../store/paths';
import type { InventorySnapshot } from '../indexer';
import { buildGraph } from './build';
import { ResolutionCache } from './resolution-cache';
import { serializeGraph } from './serialize';
import { buildSearchCorpus, type SearchCorpus } from '../query/corpus';
import { CodeSearch } from '../query/search';

export interface PublishedGraph {
  graph: CodeMapGraph;
  manifest: CodeMapManifest;
  bytes: number;
  diagnostics: CodeMapDiagnostics;
}
/** Small edits to graphs of at least this many files are written to disk after a quiet period, not before publishing. */
const DEFER_MINIMUM_FILES = 300;
const DEFER_MAXIMUM_CHANGED = 50;
const PERSIST_QUIET_MS = 1000;
const PERSIST_MAXIMUM_MS = 10_000;
/** A generation waiting to be written; records of earlier skipped generations are carried along. */
interface PersistJob {
  graph: CodeMapGraph;
  configs: ReadonlyMap<string, ProjectConfig>;
  manifest: CodeMapManifest;
  cache: Map<string, string>;
  live: Set<string>;
}
const intents = (record: FileRecord) =>
  record.relations.length +
  record.imports.length +
  (record.csharp?.relations.length ?? 0) +
  (record.go ? record.go.calls.length + record.go.imports.length : 0) +
  (record.java ? record.java.calls.length + record.java.imports.length + record.java.references.length : 0) +
  (record.python ? record.python.calls.length + record.python.imports.length + record.python.bases.length : 0);
export class GraphEngine {
  readonly records = new Map<string, FileRecord>();
  readonly configs = new Map<string, ProjectConfig>();
  private readonly dirtyCache = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  private grammarVersions: Record<string, string> = {};
  private manifest: CodeMapManifest | undefined;
  private graph: CodeMapGraph | undefined;
  /** Search terms of the published graph; replaced together with it, never mutated. */
  private corpus: SearchCorpus = new Map();
  private publishedConfigs: ReadonlyMap<string, ProjectConfig> = new Map();
  private directory = '';
  private rebuildVersion = 0;
  private appliedRebuild = 0;
  private activeRebuild = 0;
  private symbolCount = 0;
  private relationCount = 0;
  private runtimeVersion = '';
  private bytes = 0;
  private revision = 0;
  private checkpoint: { revision: number; diagnostics: string; published: PublishedGraph } | undefined;
  private readonly cache: CacheStore;
  /** Relations resolved in earlier builds; only files whose inputs changed are resolved again. */
  private readonly resolution = new ResolutionCache();
  private readonly changedPaths = new Set<string>();
  /** Records replaced since the published graph (and its search index) was built. */
  private readonly searchChanged = new Set<string>();
  private searchIndex: CodeSearch | undefined;
  private searchBuild: { promise: Promise<void>; cancelled: boolean } | undefined;
  /** The newest published generation that is not on disk yet. */
  private pending: PersistJob | undefined;
  private pendingSince: number | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistPaused = false;
  private disposed = false;
  /** Disk writes run one at a time, oldest generation first. */
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      root: string;
      assets: string;
      version: string;
      excludedPaths: string[];
      parser: Pick<ParserClient, 'parse'>;
      assertOwned(): Promise<void>;
      /** A deferred write finished; `bytes` is the size of the map data on disk. */
      persisted?(bytes: number): void;
      persistFailed?(error: unknown): void;
    },
  ) {
    this.cache = new CacheStore(options.root);
  }
  async initialize(): Promise<void> {
    this.directory = await safeDirectory(this.options.root, ['.oxy', 'code-map']);
    await this.cache.load();
    const grammars = GrammarManifestSchema.parse(
      JSON.parse(await readFile(join(this.options.assets, 'grammars.json'), 'utf8')),
    );
    this.grammarVersions = Object.fromEntries(
      [
        ...new Map(
          grammars.grammars
            .filter((entry) =>
              ['javascript', 'typescript', 'tsx', 'csharp', 'go', 'java', 'python'].includes(entry.language),
            )
            .map((entry) => [entry.package, entry.version]),
        ).entries(),
      ].sort(([a], [b]) => comparePaths(a, b)),
    );
    const snapshot = await loadSnapshot(this.directory);
    this.runtimeVersion = grammars.runtime.version;
    if (snapshot) {
      this.manifest = snapshot.manifest;
      this.graph = snapshot.graph;
      const symbols = new Map<string, CodeMapGraph['symbols']>();
      for (const symbol of snapshot.graph.symbols) {
        const list = symbols.get(symbol.file) ?? [];
        list.push(symbol);
        symbols.set(symbol.file, list);
      }
      for (const file of snapshot.graph.files) {
        const cached = await this.cached(file.path, file.sha256);
        if (cached) this.store(file.path, cached);
        else {
          const fallback = fileRecord(file.path, '');
          fallback.file = file;
          fallback.symbols = symbols.get(file.id) ?? [];
          this.store(file.path, fallback);
        }
      }
      this.corpus = buildSearchCorpus(this.records);
    } else {
      try {
        this.manifest = CodeMapManifestSchema.parse(
          JSON.parse(await readFile(join(this.directory, 'manifest.json'), 'utf8')),
        );
      } catch {
        /* Derived metadata is rebuilt. */
      }
    }
  }
  private cacheKey(path: string, hash: string): string {
    return sha256(
      JSON.stringify({
        path,
        hash,
        version: EXTRACTOR_VERSION,
        grammars: this.grammarVersions,
        runtime: this.runtimeVersion,
      }),
    );
  }
  private async cached(path: string, hash: string): Promise<FileRecord | null> {
    const text = await this.cache.read(this.cacheKey(path, hash));
    if (text === null) return null;
    try {
      const record = FileRecordSchema.parse(JSON.parse(text));
      return record.file.path === path && record.file.sha256 === hash ? record : null;
    } catch {
      return null;
    }
  }
  start(): void {
    this.failures.clear();
    this.activeRebuild = this.rebuildVersion;
    if (this.activeRebuild !== this.appliedRebuild) this.dirtyCache.clear();
  }
  async file(path: string, source: string, signal?: AbortSignal): Promise<boolean> {
    const base = fileRecord(path, source);
    const previous = this.records.get(path);
    let record: FileRecord;
    try {
      const config = parseProjectConfig(path, source);
      if (config) this.configs.set(path, config);
      const cached = this.activeRebuild === this.appliedRebuild ? await this.cached(path, base.file.sha256) : null;
      if (cached && cached.file.status !== 'failed') record = cached;
      else if (parserLanguage(path)) record = await this.options.parser.parse(path, source, signal);
      else {
        // Files without a parser are found by name, path and their bounded text prefix.
        base.search = buildSearchData(normalizedSource(source), []);
        record = base;
      }
      if (record.syntaxErrors) {
        this.failures.set(
          path,
          'Syntax errors; declarations may be incomplete or retained from a previous source revision.',
        );
        if (previous?.symbols.length)
          record = {
            ...previous,
            file: { ...record.file, stale: true },
            syntaxErrors: record.syntaxErrors,
            symbols: previous.symbols.map((symbol) => ({ ...symbol, stale: true })),
          };
        else record.symbols = record.symbols.map((symbol) => ({ ...symbol, stale: true }));
      }
      this.store(path, record);
      if (!cached || cached.file.status === 'failed')
        this.dirtyCache.set(
          this.cacheKey(path, record.file.sha256),
          `${JSON.stringify(FileRecordSchema.parse(record))}\n`,
        );
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CodeMapLimitError) throw error;
      this.configs.delete(path);
      const reason = error instanceof Error ? error.message : String(error);
      base.search ??= buildSearchData(normalizedSource(source), []);
      this.failed(path, reason, base);
      return false;
    }
  }
  failed(path: string, reason: string, base?: FileRecord): void {
    this.failures.set(path, reason);
    const old = this.records.get(path);
    const record = old
      ? {
          ...old,
          file: { ...(base?.file ?? old.file), status: 'failed' as const, stale: true },
          symbols: old.symbols.map((symbol) => ({ ...symbol, stale: true })),
        }
      : (base ?? fileRecord(path, ''));
    record.file.status = 'failed';
    this.store(path, record);
  }
  removed(path: string): void {
    const record = this.records.get(path);
    if (record) {
      this.revision++;
      this.symbolCount -= record.symbols.length;
      this.relationCount -= intents(record);
    }
    this.changedPaths.add(path);
    this.searchChanged.add(path);
    this.records.delete(path);
    this.configs.delete(path);
    this.failures.delete(path);
  }
  rebuild(): void {
    this.rebuildVersion++;
  }
  async complete(inventory: InventorySnapshot, signal: AbortSignal): Promise<PublishedGraph> {
    for (const path of this.records.keys())
      if (!inventory.files.has(path) && !this.failures.has(path)) this.removed(path);
    const diagnosticsKey = JSON.stringify([inventory.skippedCount, inventory.diagnostics]);
    // A query metadata audit must not resolve and serialize the entire unchanged graph.
    if (
      this.checkpoint?.revision === this.revision &&
      this.checkpoint.diagnostics === diagnosticsKey &&
      this.manifest
    ) {
      const now = new Date(inventory.checkedAt).toISOString();
      const manifest = {
        ...this.manifest,
        lastReconciledAt: now,
        lastFullHashAt: inventory.fullHash ? now : this.manifest.lastFullHashAt,
      };
      signal.throwIfAborted();
      // The manifest is a few hundred bytes; it is rewritten with the pending snapshot while one is waiting.
      if (!this.pending) {
        await this.options.assertOwned();
        await atomicWrite(join(this.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      }
      signal.throwIfAborted();
      this.manifest = manifest;
      if (this.pending) this.pending.manifest = manifest;
      return { ...this.checkpoint.published, manifest };
    }
    if (
      [...this.configs.values()].reduce((size, config) => size + Buffer.byteLength(JSON.stringify(config)), 0) >
      16 * 1024 * 1024
    )
      throw new CodeMapLimitError('Code Map configuration limit reached — add exclusions');
    const resolveStart = performance.now();
    const graph = buildGraph(
      this.records,
      this.configs,
      {
        oxytocin: this.options.version,
        extractors: {
          csharp: EXTRACTOR_VERSION,
          files: 1,
          go: EXTRACTOR_VERSION,
          java: EXTRACTOR_VERSION,
          python: EXTRACTOR_VERSION,
          typescript: EXTRACTOR_VERSION,
        },
        grammars: this.grammarVersions,
        settingsHash: `sha256:${sha256(JSON.stringify([...new Set(this.options.excludedPaths)].sort(comparePaths)))}`,
      },
      inventory.skippedCount,
      undefined,
      this.resolution,
    );
    // Captured with the graph, before any await: both describe the same records.
    const corpus = buildSearchCorpus(this.records);
    const now = new Date(inventory.checkedAt).toISOString();
    const manifest = CodeMapManifestSchema.parse({
      format: 'oxytocin.code-map.manifest',
      schemaVersion: 1,
      state: graph.coverage.files.failed ? 'degraded' : 'ready',
      // Describes the graph.json on disk: replaced by the real hash when this generation is persisted.
      graphSha256: this.manifest?.graphSha256 ?? '0'.repeat(64),
      generation: (this.manifest?.generation ?? 0) + 1,
      builtAt: now,
      lastReconciledAt: now,
      lastFullHashAt: inventory.fullHash ? now : (this.manifest?.lastFullHashAt ?? now),
      durationsMs: {
        enumerate: inventory.enumerateMs,
        parse: inventory.readMs,
        resolve: performance.now() - resolveStart,
        write: 0,
      },
      counts: { files: graph.files.length, symbols: graph.symbols.length, edges: graph.edges.length },
      limits: CODE_MAP_LIMITS,
      warnings: graph.coverage.files.failed
        ? [`${graph.coverage.files.failed} files have incomplete or failed extraction`]
        : [],
    });
    signal.throwIfAborted();
    const changed = this.changedPaths.size;
    this.changedPaths.clear();
    const job: PersistJob = {
      graph,
      configs: new Map(this.configs),
      manifest,
      cache: new Map([...(this.pending?.cache ?? []), ...this.dirtyCache]),
      live: new Set([...this.records].map(([path, record]) => this.cacheKey(path, record.file.sha256))),
    };
    // Small edits to a large graph are published in memory now and written to disk after the edit burst settles;
    // everything else (first index, bulk changes, small projects) is written before it is published.
    const defer =
      !!this.manifest &&
      this.activeRebuild === this.appliedRebuild &&
      this.records.size >= DEFER_MINIMUM_FILES &&
      changed <= DEFER_MAXIMUM_CHANGED &&
      changed * 20 <= this.records.size;
    if (!defer) {
      await this.enqueue(() => this.persist(job, signal));
      this.pending = undefined;
      this.pendingSince = undefined;
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.manifest = job.manifest;
    this.graph = graph;
    this.corpus = corpus;
    this.publishedConfigs = job.configs;
    this.updateSearch(graph, corpus);
    this.appliedRebuild = this.activeRebuild;
    this.dirtyCache.clear();
    if (defer) this.schedulePersist(job);
    const failed = [
      ...inventory.diagnostics.failed,
      ...[...this.failures].map(([path, reason]) => ({ path, reason })),
      ...[...this.records]
        .filter(([, record]) => ['failed', 'syntax-errors'].includes(record.file.status))
        .filter(([path]) => !this.failures.has(path))
        .map(([path]) => ({ path, reason: 'Extraction is incomplete or retained from a previous source revision.' })),
    ];
    const published: PublishedGraph = {
      graph,
      manifest: this.manifest,
      bytes: this.bytes || this.cache.bytes,
      diagnostics: {
        skipped: inventory.diagnostics.skipped,
        failed: failed.slice(0, 200),
        unresolved: graph.unresolved.slice(0, 200),
        truncated: inventory.diagnostics.truncated || failed.length > 200 || graph.unresolved.length > 200,
      },
    };
    this.checkpoint = { revision: this.revision, diagnostics: diagnosticsKey, published };
    return published;
  }
  /**
   * Keeps the search index in step with the published graph: small changes update it in place (queries never wait
   * for it), larger ones rebuild it in the background. Nothing is built before the first search query asks.
   */
  private updateSearch(graph: CodeMapGraph, corpus: SearchCorpus): void {
    const changed = new Set(this.searchChanged);
    this.searchChanged.clear();
    if (this.searchBuild) {
      this.searchBuild.cancelled = true;
      this.searchBuild = undefined;
    }
    if (!this.searchIndex) return;
    const small = changed.size <= 200 && changed.size * 5 <= graph.files.length;
    // C# files are merged and flagged across files, so a change can alter documents of other files.
    const independent = !graph.files.some((file) => file.language === 'csharp');
    if (small && independent && this.searchIndex.update(graph, corpus, changed)) return;
    this.searchIndex = undefined;
    this.buildSearch();
  }
  private buildSearch(): void {
    if (this.searchIndex || this.searchBuild || !this.graph) return;
    const graph = this.graph;
    const build = { cancelled: false, promise: Promise.resolve() };
    build.promise = CodeSearch.build(graph, this.corpus, () => build.cancelled)
      .then((index) => {
        if (index && !build.cancelled && this.graph === graph) this.searchIndex = index;
      })
      .finally(() => {
        if (this.searchBuild === build) this.searchBuild = undefined;
      });
    this.searchBuild = build;
  }
  /** Resolves once the published generation has a search index; call before taking the snapshot to search. */
  async ensureSearch(): Promise<void> {
    while (!this.searchIndex && this.graph) {
      this.buildSearch();
      await this.searchBuild?.promise;
    }
  }
  /** The search index of `graph`, which must be the published generation. */
  search(graph: CodeMapGraph, corpus: SearchCorpus): CodeSearch {
    if (graph !== this.graph) return new CodeSearch(graph, corpus);
    return (this.searchIndex ??= new CodeSearch(graph, corpus));
  }
  /** Writes one generation: graph.json, MAP.md, the manifest and new extraction records. */
  private async persist(job: PersistJob, signal?: AbortSignal): Promise<void> {
    const serialized = await serializeGraph(job.graph);
    signal?.throwIfAborted();
    const manifest = CodeMapManifestSchema.parse({ ...job.manifest, graphSha256: serialized.hash });
    const owned = async () => {
      signal?.throwIfAborted();
      await this.options.assertOwned();
    };
    const published = await publishSnapshot(
      this.options.root,
      {
        graph: serialized.text,
        map: renderMapMarkdown(job.graph, job.configs, undefined, serialized.hash),
        manifest,
        cache: job.cache,
        liveCacheKeys: job.live,
      },
      owned,
      this.cache,
    );
    job.manifest = published.manifest;
    this.bytes = published.bytes;
    // The published manifest of this or a newer generation learns the hash of what is on disk.
    if (this.manifest && this.manifest.generation >= job.manifest.generation)
      this.manifest = { ...this.manifest, graphSha256: published.manifest.graphSha256 };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writing.catch(() => undefined).then(operation);
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private schedulePersist(job: PersistJob): void {
    this.pending = job;
    this.pendingSince ??= Date.now();
    this.armPersist();
  }
  private armPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.pending || this.persistPaused || this.disposed) return;
    const wait = Math.min(PERSIST_QUIET_MS, Math.max(0, this.pendingSince! + PERSIST_MAXIMUM_MS - Date.now()));
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch((error: unknown) => this.options.persistFailed?.(error));
    }, wait);
    this.persistTimer.unref();
  }
  /** Persists the generation waiting for disk, if any. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      const job = this.pending;
      if (!job || this.disposed || this.persistPaused) return;
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.persist(job);
      // A generation published while this one was written stays pending.
      if (this.pending === job) {
        this.pending = undefined;
        this.pendingSince = undefined;
      } else this.pendingSince = Date.now();
      this.options.persisted?.(this.bytes);
      if (this.pending) this.armPersist();
    });
  }
  /** Nothing is written while the index is paused; the waiting generation is kept. */
  holdPersistence(held: boolean): void {
    this.persistPaused = held;
    if (held && this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!held) this.armPersist();
  }
  dispose(): void {
    this.disposed = true;
    if (this.searchBuild) this.searchBuild.cancelled = true;
    this.searchBuild = undefined;
    this.searchIndex = undefined;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.pending = undefined;
    this.records.clear();
    this.configs.clear();
    this.dirtyCache.clear();
    this.failures.clear();
    this.symbolCount = this.relationCount = 0;
    this.resolution.clear();
  }
  /** One published generation: graph, manifest and the search corpus built from the same records. */
  snapshot(): {
    graph: CodeMapGraph;
    manifest: CodeMapManifest;
    configs: ReadonlyMap<string, ProjectConfig>;
    corpus: SearchCorpus;
  } | null {
    return this.graph && this.manifest
      ? { graph: this.graph, manifest: this.manifest, configs: this.publishedConfigs, corpus: this.corpus }
      : null;
  }
  private store(path: string, record: FileRecord): void {
    const old = this.records.get(path);
    const symbols = this.symbolCount - (old?.symbols.length ?? 0) + record.symbols.length;
    const relations = this.relationCount - (old ? intents(old) : 0) + intents(record);
    if (symbols > CODE_MAP_LIMITS.symbols || relations > CODE_MAP_LIMITS.edges) throw new CodeMapLimitError();
    this.symbolCount = symbols;
    this.relationCount = relations;
    this.revision++;
    this.changedPaths.add(path);
    this.searchChanged.add(path);
    this.records.set(path, record);
  }
}
