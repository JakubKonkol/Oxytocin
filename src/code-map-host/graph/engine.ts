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
import { fileRecord } from '../extract/files';
import { parserLanguage } from '../extract/languages';
import type { ParserClient } from '../parse/client';
import { parseProjectConfig, type ProjectConfig } from '../resolve/config';
import { renderMapMarkdown } from '../map-md';
import { atomicWrite, CacheStore, loadSnapshot, publishSnapshot, sha256 } from '../store/writer';
import { safeDirectory } from '../store/paths';
import type { InventorySnapshot } from '../indexer';
import { buildGraph } from './build';

export interface PublishedGraph {
  graph: CodeMapGraph;
  manifest: CodeMapManifest;
  bytes: number;
  diagnostics: CodeMapDiagnostics;
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
  constructor(
    private readonly options: {
      root: string;
      assets: string;
      version: string;
      excludedPaths: string[];
      parser: Pick<ParserClient, 'parse'>;
      assertOwned(): Promise<void>;
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
      else record = parserLanguage(path) ? await this.options.parser.parse(path, source, signal) : base;
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
      await this.options.assertOwned();
      await atomicWrite(join(this.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      signal.throwIfAborted();
      this.manifest = manifest;
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
    );
    const graphText = `${JSON.stringify(graph)}\n`;
    const hash = sha256(graphText);
    const same = this.graph && hash === this.manifest?.graphSha256 && this.dirtyCache.size === 0;
    const now = new Date(inventory.checkedAt).toISOString();
    const manifest = CodeMapManifestSchema.parse({
      format: 'oxytocin.code-map.manifest',
      schemaVersion: 1,
      state: graph.coverage.files.failed ? 'degraded' : 'ready',
      graphSha256: hash,
      generation: (this.manifest?.generation ?? 0) + (same ? 0 : 1),
      builtAt: same ? this.manifest!.builtAt : now,
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
    const owned = async () => {
      signal.throwIfAborted();
      await this.options.assertOwned();
    };
    if (same) {
      await owned();
      await atomicWrite(join(this.directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      this.manifest = manifest;
    } else {
      const keys = new Set([...this.records].map(([path, record]) => this.cacheKey(path, record.file.sha256)));
      const published = await publishSnapshot(
        this.options.root,
        {
          graph: graphText,
          map: renderMapMarkdown(graph, this.configs, undefined, hash),
          manifest,
          cache: this.dirtyCache,
          liveCacheKeys: keys,
        },
        owned,
        this.cache,
      );
      this.manifest = published.manifest;
      this.bytes = published.bytes;
    }
    this.graph = graph;
    this.publishedConfigs = new Map(this.configs);
    this.appliedRebuild = this.activeRebuild;
    this.dirtyCache.clear();
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
      bytes: this.bytes || this.cache.bytes + Buffer.byteLength(graphText),
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
  dispose(): void {
    this.records.clear();
    this.configs.clear();
    this.dirtyCache.clear();
    this.failures.clear();
    this.symbolCount = this.relationCount = 0;
  }
  snapshot(): { graph: CodeMapGraph; manifest: CodeMapManifest; configs: ReadonlyMap<string, ProjectConfig> } | null {
    return this.graph && this.manifest
      ? { graph: this.graph, manifest: this.manifest, configs: this.publishedConfigs }
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
    this.records.set(path, record);
  }
}
