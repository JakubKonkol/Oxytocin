import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeMapDiagnostics } from '@shared/domain/code-map';
import { CodeMapWatch, discoverGitWatchDirectories, type WatchSubscribe } from './watch';
import type { CodeMapScheduler, BuildRequest } from './scheduler';
import { enumerate, metadataOf, type Enumeration } from './enumerate';
import { fingerprint, sameMetadata, type Fingerprint } from './fingerprint';

function bounded(skipped: ReadonlyMap<string, string>, failed: ReadonlyMap<string, string>): CodeMapDiagnostics {
  const list = (entries: ReadonlyMap<string, string>) =>
    [...entries]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, 200)
      .map(([path, reason]) => ({ path, reason }));
  return {
    skipped: list(skipped),
    failed: list(failed),
    unresolved: [],
    truncated: skipped.size > 200 || failed.size > 200,
  };
}

/** Number of most recently modified files whose metadata a query probes (a few milliseconds of stat calls). */
const RECENT_PROBE = 64;

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
  file(
    path: string,
    fingerprint: Fingerprint,
    source: string,
    signal: AbortSignal,
  ): Promise<void | boolean> | void | boolean;
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
  private readonly failedPaths = new Set<string>();
  private activeSequence = 0;
  /** Exclusions and probe failures of the inventory, kept complete so path-limited updates stay exact. */
  private skipped: Map<string, string> | undefined;
  private probeFailures = new Map<string, string>();
  private verification: { promise: Promise<void>; resolve(): void; reject(error: unknown): void } | undefined;
  /** Readers waiting for the build that covers a watcher sequence. */
  private waiters: { sequence: number; resolve(): void; reject(error: unknown): void }[] = [];
  /** The most recently modified indexed files, probed by `prepare` to cover the watcher's delivery delay. */
  private recent: string[] = [];
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
        const verification = request.reconcile ? this.verification : undefined;
        if (verification) this.verification = undefined;
        const operation = this.reconcile(request, signal);
        this.running = operation;
        try {
          await operation;
          verification?.resolve();
          this.releaseWaiters();
        } catch (error) {
          verification?.reject(error);
          this.releaseWaiters(error);
          throw error;
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
    this.verification?.reject(new Error('Code Map updates paused'));
    this.verification = undefined;
    this.releaseWaiters(new Error('Code Map updates paused'));
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
  /** Concurrent callers queue one audit. Cancelling a reader never aborts this shared work. */
  verify(fullHash: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Code Map checkout closed'));
    if (!this.verification) {
      const pending = {} as NonNullable<CheckoutIndexer['verification']>;
      pending.promise = new Promise<void>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
      this.verification = pending;
    }
    this.options.scheduler.request(this.options.checkoutId, {
      immediate: true,
      reconcile: true,
      fullHash,
      forQuery: true,
    });
    return this.verification.promise;
  }
  /**
   * What a `latest` query must do before it may answer from the published snapshot:
   * - `current`: the event stream is healthy and nothing is pending, so no audit is needed;
   * - `catch-up`: events newer than the published build exist, so only the build they trigger is awaited;
   * - `audit`: the stream cannot be trusted (initial scan, overflow, error, forced rebuild), so reconcile fully.
   * A metadata probe of the most recently modified files turns an edit that the watcher has not delivered yet
   * (inotify and ReadDirectoryChanges report after a short delay) into a pending event.
   */
  async prepare(): Promise<'current' | 'catch-up' | 'audit'> {
    if (this.closed || !this.watcher.healthy || this.rebuildVersion !== this.appliedRebuild) return 'audit';
    if (!this.watcher.dirty) await this.probeRecent();
    return this.watcher.dirty ? 'catch-up' : 'current';
  }
  /** Requests the incremental build for pending events now (no debounce) and waits for it to be published. */
  catchUp(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Code Map checkout closed'));
    const waiter = {} as (typeof this.waiters)[number];
    const promise = new Promise<void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    waiter.sequence = this.watcher.latestSequence;
    this.waiters.push(waiter);
    this.options.scheduler.request(this.options.checkoutId, { immediate: true, forQuery: true });
    return promise;
  }
  private releaseWaiters(error?: unknown): void {
    const committed = this.committedSequence;
    this.waiters = this.waiters.filter((waiter) => {
      if (error !== undefined) waiter.reject(error);
      else if (waiter.sequence <= committed) waiter.resolve();
      else return true;
      return false;
    });
  }
  private committedSequence = 0;
  private async probeRecent(): Promise<void> {
    const changed: string[] = [];
    await Promise.all(
      this.recent.map(async (path) => {
        const known = this.files.get(path);
        if (!known) return;
        try {
          const info = await stat(join(this.options.root, ...path.split('/')), { bigint: true });
          if (!sameMetadata(known.metadata, metadataOf(info))) changed.push(path);
        } catch {
          changed.push(path);
        }
      }),
    );
    if (changed.length) this.watcher.observe(changed.sort());
  }
  private async reconcile(request: BuildRequest, signal: AbortSignal): Promise<void> {
    const rebuildVersion = this.rebuildVersion;
    const reextract = rebuildVersion !== this.appliedRebuild;
    const checkpoint = this.watcher.checkpoint();
    this.activeSequence = checkpoint.sequence;
    const started = performance.now();
    const dirty = new Set([...request.paths, ...checkpoint.changes.map((change) => change.path)]);
    const fullHash = request.fullHash || checkpoint.unknown;
    const paths = !request.reconcile && !fullHash && !reextract && this.skipped ? await this.limitedPaths(dirty) : null;
    const enumeration: Enumeration = await enumerate({ ...this.options, signal, ...(paths ? { paths } : {}) });
    const skipped = paths ? new Map(this.skipped) : enumeration.skippedPaths;
    const probeFailures = paths ? new Map(this.probeFailures) : enumeration.failedPaths;
    if (paths)
      for (const path of paths) {
        skipped.delete(path);
        probeFailures.delete(path);
      }
    for (const [path, reason] of paths ? enumeration.skippedPaths : []) skipped.set(path, reason);
    for (const [path, reason] of paths ? enumeration.failedPaths : []) probeFailures.set(path, reason);
    enumeration.skippedCount = skipped.size;
    enumeration.diagnostics = bounded(skipped, probeFailures);
    const enumerateMs = performance.now() - started;
    signal.throwIfAborted();
    const { hooks } = this.options;
    hooks.start(enumeration.files.length);
    const next = paths ? new Map(this.files) : new Map<string, Fingerprint>();
    const currentPaths = new Set(enumeration.files.map((file) => file.path));
    for (const path of paths ?? this.files.keys())
      if (!currentPaths.has(path) && this.files.has(path)) {
        hooks.removed(path);
        next.delete(path);
      }
    const readStart = performance.now();
    for (let offset = 0; offset < enumeration.files.length; offset += 32) {
      signal.throwIfAborted();
      const batch = await Promise.all(
        enumeration.files.slice(offset, offset + 32).map(async (file) => {
          const previous = this.files.get(file.path);
          if (
            !fullHash &&
            !dirty.has(file.path) &&
            !this.failedPaths.has(file.path) &&
            previous &&
            sameMetadata(previous.metadata, file.metadata)
          )
            return { path: file.path, fingerprint: previous };
          try {
            return { path: file.path, ...(await fingerprint(enumeration.root, file.path, signal)) };
          } catch (error) {
            signal.throwIfAborted();
            const reason = error instanceof Error ? error.message : String(error);
            hooks.failed(file.path, reason);
            this.failedPaths.add(file.path);
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
          (reextract ||
            this.failedPaths.has(file.path) ||
            file.fingerprint.sha256 !== this.files.get(file.path)?.sha256)
        ) {
          const successful = await hooks.file(file.path, file.fingerprint, file.source, signal);
          if (successful === false) this.failedPaths.add(file.path);
          else this.failedPaths.delete(file.path);
        }
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
    this.skipped = skipped;
    this.probeFailures = probeFailures;
    this.appliedRebuild = rebuildVersion;
    this.lastReconciled = checkedAt;
    if (fullHash) this.lastFullHash = checkedAt;
    this.watcher.commit(checkpoint.sequence);
    this.committedSequence = Math.max(this.committedSequence, checkpoint.sequence);
    this.recent = [...next]
      .sort(([, left], [, right]) => Number(right.metadata.mtimeNs) - Number(left.metadata.mtimeNs))
      .slice(0, RECENT_PROBE)
      .map(([path]) => path);
    // Events that arrived during this build are covered by a path-limited follow-up, not a full scan.
    if (this.watcher.checkpoint().sequence > checkpoint.sequence)
      this.options.scheduler.request(this.options.checkoutId, { immediate: true });
  }
  /**
   * Watcher batches touching only known files are enumerated path by path. Directories, ignore rules and project
   * files change what a full scan would include, so they still reconcile the whole checkout.
   */
  private async limitedPaths(dirty: ReadonlySet<string>): Promise<string[] | null> {
    const paths = [...dirty].sort();
    if (!paths.length || paths.length > 500 || paths.join('').length > 8000) return null;
    if (paths.some((path) => /(^|\/)(\.gitignore|[^/]+\.(cs|fs|vb)proj)$/i.test(path))) return null;
    for (const path of paths) {
      const prefix = `${path}/`;
      for (const known of this.files.keys()) if (known.startsWith(prefix)) return null;
      for (const known of this.skipped?.keys() ?? []) if (known.startsWith(prefix)) return null;
      const info = await lstat(join(this.options.root, ...path.split('/'))).catch(() => null);
      if (info?.isDirectory()) return null;
    }
    return paths;
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.verification?.reject(new Error('Code Map checkout closed'));
    this.verification = undefined;
    this.releaseWaiters(new Error('Code Map checkout closed'));
    if (this.timer) clearInterval(this.timer);
    this.options.scheduler.remove(this.options.checkoutId);
    await this.watcher.close();
    await this.running?.catch(() => undefined);
    this.files.clear();
    this.failedPaths.clear();
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get pendingFiles(): number {
    const checkpoint = this.watcher.checkpoint();
    return checkpoint.sequence > this.activeSequence
      ? Math.max(1, checkpoint.changes.filter((change) => change.sequence > this.activeSequence).length)
      : 0;
  }
}
