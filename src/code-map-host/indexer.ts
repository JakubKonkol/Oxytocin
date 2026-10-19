import type { CodeMapDiagnostics } from '@shared/domain/code-map';
import { CodeMapWatch, discoverGitWatchDirectories, type WatchSubscribe } from './watch';
import type { CodeMapScheduler, BuildRequest } from './scheduler';
import { enumerate, type Enumeration } from './enumerate';
import { fingerprint, sameMetadata, type Fingerprint } from './fingerprint';

export interface InventorySnapshot {
  files: ReadonlyMap<string, Fingerprint>;
  diagnostics: CodeMapDiagnostics;
  skippedCount: number;
  fullHash: boolean;
  checkedAt: number;
  enumerateMs: number;
  readMs: number;
}
export interface IndexerHooks {
  start(total: number): void;
  file(path: string, fingerprint: Fingerprint, source: string): Promise<void> | void;
  removed(path: string): void;
  failed(path: string, reason: string): void;
  complete(snapshot: InventorySnapshot, signal: AbortSignal): Promise<void> | void;
  error(error: unknown): void;
  pending?(count: number): void;
}

/** Owns observation and fingerprints; extraction is supplied by the next pipeline stage. */
export class CheckoutIndexer {
  private readonly watcher: CodeMapWatch;
  private files = new Map<string, Fingerprint>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private lastReconciled = 0;
  private lastFullHash = 0;
  private closed = false;
  private rebuildVersion = 0;
  private appliedRebuild = 0;
  constructor(
    private readonly options: {
      checkoutId: string;
      projectId: string;
      root: string;
      gitPath: string;
      excludedPaths: readonly string[];
      scheduler: CodeMapScheduler;
      hooks: IndexerHooks;
      subscribe?: WatchSubscribe;
    },
  ) {
    this.watcher = new CodeMapWatch(
      options.root,
      ({ paths, reconcile }) => {
        options.scheduler.request(options.checkoutId, { paths, reconcile });
        options.hooks.pending?.(this.watcher.checkpoint().changes.length || 1);
      },
      options.subscribe,
    );
  }
  async start(): Promise<void> {
    const { scheduler, checkoutId, projectId, hooks } = this.options;
    scheduler.register(
      checkoutId,
      projectId,
      async (request, signal) => {
        const operation = this.reconcile(request, signal);
        this.running = operation;
        try {
          await operation;
        } finally {
          this.running = undefined;
        }
      },
      (error) => hooks.error(error),
    );
    try {
      await this.watcher.start(await discoverGitWatchDirectories(this.options.root, this.options.gitPath));
    } catch (error) {
      scheduler.remove(checkoutId);
      throw error;
    }
    scheduler.request(checkoutId, { immediate: true, reconcile: true, fullHash: true });
    this.timer = setInterval(() => {
      const period = scheduler.isActive(projectId) ? 60_000 : 600_000;
      if (Date.now() - this.lastReconciled >= period)
        scheduler.request(checkoutId, {
          immediate: true,
          reconcile: true,
          fullHash: Date.now() - this.lastFullHash >= 1_800_000,
        });
    }, 60_000);
    this.timer.unref();
  }
  pause(): void {
    this.options.scheduler.pause(this.options.checkoutId);
  }
  resume(): void {
    this.options.scheduler.resume(this.options.checkoutId);
  }
  rebuild(): void {
    this.rebuildVersion++;
    this.options.scheduler.request(this.options.checkoutId, { immediate: true, reconcile: true, fullHash: true });
  }
  reconcileSoon(fullHash = false): void {
    this.options.scheduler.request(this.options.checkoutId, { immediate: true, reconcile: true, fullHash });
  }
  private async reconcile(request: BuildRequest, signal: AbortSignal): Promise<void> {
    const rebuildVersion = this.rebuildVersion;
    const reextract = rebuildVersion !== this.appliedRebuild;
    const checkpoint = this.watcher.checkpoint();
    const started = performance.now();
    const enumeration: Enumeration = await enumerate({ ...this.options, signal });
    const enumerateMs = performance.now() - started;
    signal.throwIfAborted();
    const { hooks } = this.options;
    hooks.start(enumeration.files.length);
    const dirty = new Set([...request.paths, ...checkpoint.changes.map((change) => change.path)]);
    const fullHash = request.fullHash || checkpoint.unknown;
    const next = new Map<string, Fingerprint>();
    const currentPaths = new Set(enumeration.files.map((file) => file.path));
    for (const path of this.files.keys()) if (!currentPaths.has(path)) hooks.removed(path);
    const readStart = performance.now();
    for (let offset = 0; offset < enumeration.files.length; offset += 32) {
      signal.throwIfAborted();
      const batch = await Promise.all(
        enumeration.files.slice(offset, offset + 32).map(async (file) => {
          const previous = this.files.get(file.path);
          if (!fullHash && !dirty.has(file.path) && previous && sameMetadata(previous.metadata, file.metadata))
            return { path: file.path, fingerprint: previous };
          try {
            return { path: file.path, ...(await fingerprint(enumeration.root, file.path, signal)) };
          } catch (error) {
            signal.throwIfAborted();
            const reason = error instanceof Error ? error.message : String(error);
            hooks.failed(file.path, reason);
            if (enumeration.diagnostics.failed.length < 200)
              enumeration.diagnostics.failed.push({ path: file.path, reason });
            else enumeration.diagnostics.truncated = true;
            return { path: file.path, fingerprint: previous };
          }
        }),
      );
      for (const file of batch) {
        signal.throwIfAborted();
        if (!file.fingerprint) continue;
        next.set(file.path, file.fingerprint);
        if (
          'source' in file &&
          file.source !== undefined &&
          (reextract || file.fingerprint.sha256 !== this.files.get(file.path)?.sha256)
        )
          await hooks.file(file.path, file.fingerprint, file.source);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal.throwIfAborted();
    const checkedAt = Date.now();
    await hooks.complete(
      {
        files: next,
        diagnostics: enumeration.diagnostics,
        skippedCount: enumeration.skippedCount,
        fullHash,
        checkedAt,
        enumerateMs,
        readMs: performance.now() - readStart,
      },
      signal,
    );
    signal.throwIfAborted();
    this.files = next;
    this.appliedRebuild = rebuildVersion;
    this.lastReconciled = checkedAt;
    if (fullHash) this.lastFullHash = checkedAt;
    this.watcher.commit(checkpoint.sequence);
    if (this.watcher.checkpoint().sequence > checkpoint.sequence) this.reconcileSoon();
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.options.scheduler.remove(this.options.checkoutId);
    await this.watcher.close();
    await this.running?.catch(() => undefined);
    this.files.clear();
  }
  get isClosed(): boolean {
    return this.closed;
  }
}
