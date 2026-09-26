import { type FSWatcher, watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type CollectedItem, isLimit, type UsageSource } from '../model';
import { type Cursor, fileInfo, needsRead, tailFile } from './tail';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const RESCAN_MS = 30_000;
const DEBOUNCE_MS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How one log format is found and parsed. */
export interface FileSourceSpec {
  source: UsageSource;
  /** Folders to scan recursively (existing ones). */
  roots: () => string[];
  match: (path: string) => boolean;
  /** Fast path before decoding a line. */
  accept: (line: Buffer) => boolean;
  /** Parses one line; `state` is the per-file collector state kept in the cursor (JSON). */
  parse: (line: string, path: string, state: Record<string, unknown>) => CollectedItem[];
  /** Files rewritten as a whole (e.g. legacy Gemini `.json`): parsed completely whenever they change. */
  parseWhole?: (text: string, path: string) => CollectedItem[];
  isWhole?: (path: string) => boolean;
  /** Picks one of several copies of the same file (e.g. Codex sessions/ vs archived_sessions/). */
  dedupeKey?: (path: string) => string | null;
}

export interface FileCollectorDeps {
  getCursor: (path: string) => Cursor | undefined;
  /** Writes the records and the new cursor in one transaction. */
  commit: (items: CollectedItem[], cursor: Cursor) => void;
  readText: (path: string) => Promise<string>;
  now: () => number;
  backfillDays: () => number;
  warn: (message: string, error?: unknown) => void;
  progress?: (source: UsageSource, done: number, total: number) => void;
}

export interface CollectorStats {
  files: number;
  lastEventAt: number | null;
  parseErrors: number;
  roots: string[];
}

/**
 * Discovers, backfills and tails the log files of one source (docs/plan/08-usage-monitor.md §5.2): a scan at start,
 * `fs.watch` (recursive) for changes, and a rescan every 30 s for robustness.
 */
export class FileCollector {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue = Promise.resolve();
  private readonly dirty = new Set<string>();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  readonly stats: CollectorStats = { files: 0, lastEventAt: null, parseErrors: 0, roots: [] };

  constructor(
    private readonly spec: FileSourceSpec,
    private readonly deps: FileCollectorDeps,
  ) {}

  /** Initial scan (backfill with progress) + watching. */
  async start(): Promise<void> {
    await this.enqueue(() => this.scan(true));
    if (this.stopped) return;
    for (const root of this.stats.roots) {
      try {
        const w = watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return this.markDirty(null);
          this.markDirty(resolve(root, filename.toString()));
        });
        w.on('error', (e) => this.deps.warn(`Watching ${root} failed`, e));
        this.watchers.push(w);
      } catch (e) {
        this.deps.warn(`Cannot watch ${root}`, e);
      }
    }
    this.timer = setInterval(() => void this.enqueue(() => this.scan(false)), RESCAN_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearInterval(this.timer);
    clearTimeout(this.debounce);
  }

  /** Waits for queued work (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  rescan(): Promise<void> {
    return this.enqueue(() => this.scan(false));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((e: unknown) => this.deps.warn(`${this.spec.source}: scan failed`, e));
    return this.queue;
  }

  private markDirty(path: string | null): void {
    if (path && !this.spec.match(path)) return;
    this.dirty.add(path ?? '*');
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const paths = [...this.dirty];
      this.dirty.clear();
      void this.enqueue(async () => {
        if (paths.includes('*')) return this.scan(false);
        for (const p of paths) await this.readFile(p);
      });
    }, DEBOUNCE_MS);
  }

  private async listFiles(): Promise<string[]> {
    const files: string[] = [];
    const chosen = new Map<string, string>();
    for (const root of this.stats.roots) {
      let entries: string[];
      try {
        entries = await readdir(root, { recursive: true });
      } catch {
        continue;
      }
      for (const rel of entries) {
        const full = join(root, rel);
        if (!this.spec.match(full)) continue;
        const key = this.spec.dedupeKey?.(full) ?? null;
        if (key !== null) {
          if (chosen.has(key)) continue;
          chosen.set(key, full);
        }
        files.push(full);
      }
    }
    return files;
  }

  private async scan(initial: boolean): Promise<void> {
    this.stats.roots = this.spec.roots();
    const files = await this.listFiles();
    this.stats.files = files.length;
    const infos: { path: string; mtimeMs: number }[] = [];
    for (const path of files) {
      try {
        const info = await fileInfo(path);
        if (needsRead(info, this.deps.getCursor(path))) infos.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // Deleted meanwhile.
      }
    }
    // Newest first so recent usage shows up early during a backfill.
    infos.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let done = 0;
    for (const { path } of infos) {
      if (this.stopped) return;
      await this.readFile(path);
      done++;
      if (initial) this.deps.progress?.(this.spec.source, done, infos.length);
    }
  }

  private async readFile(path: string): Promise<void> {
    let info;
    try {
      info = await fileInfo(path);
    } catch {
      return;
    }
    const cursor = this.deps.getCursor(path);
    if (!needsRead(info, cursor)) return;
    const base: Cursor = {
      path,
      source: this.spec.source,
      fileId: info.fileId,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: cursor?.offset ?? 0,
      state: cursor?.state ?? null,
    };
    if (info.size > MAX_FILE_BYTES) {
      this.deps.warn(`${path} is larger than 1 GB and is skipped`);
      this.deps.commit([], { ...base, offset: info.size });
      return;
    }
    // Files not touched within the backfill window are skipped (their later appends are still read).
    if (!cursor && info.mtimeMs < this.deps.now() - this.deps.backfillDays() * DAY_MS) {
      this.deps.commit([], { ...base, offset: info.size });
      return;
    }
    if (this.spec.isWhole?.(path) && this.spec.parseWhole) {
      let records: CollectedItem[] = [];
      try {
        records = this.spec.parseWhole(await this.deps.readText(path), path);
      } catch {
        this.stats.parseErrors++;
      }
      this.note(records);
      this.deps.commit(records, { ...base, offset: info.size });
      return;
    }
    let state: Record<string, unknown>;
    try {
      state = cursor?.state ? (JSON.parse(cursor.state) as Record<string, unknown>) : {};
    } catch {
      state = {};
    }
    for await (const batch of tailFile(path, cursor, this.spec.accept, info)) {
      if (batch.reset) state = {};
      const records: CollectedItem[] = [];
      for (const line of batch.lines) {
        try {
          records.push(...this.spec.parse(line.toString('utf8'), path, state));
        } catch {
          this.stats.parseErrors++;
        }
      }
      this.note(records);
      this.deps.commit(records, { ...base, offset: batch.endOffset, state: JSON.stringify(state) });
    }
  }

  private note(items: CollectedItem[]): void {
    for (const r of items) {
      if (isLimit(r)) continue;
      if (!this.stats.lastEventAt || r.ts > this.stats.lastEventAt) this.stats.lastEventAt = r.ts;
    }
  }
}
