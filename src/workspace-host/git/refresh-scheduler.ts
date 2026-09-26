export type RefreshReason = 'fs' | 'gitdir' | 'manual' | 'focus' | 'periodic' | 'initial';

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface QueueItem {
  key: string;
  execute: () => Promise<void>;
}

/**
 * One worker for all repositories: due refreshes wait here and the active project's one goes first
 * (docs/plan/06-git-changes.md §3.2).
 */
export class RefreshQueue {
  private readonly pending = new Map<string, QueueItem>();
  private busy = false;
  private activeKey: string | null = null;

  setActive(key: string | null): void {
    this.activeKey = key;
  }

  enqueue(item: QueueItem): void {
    this.pending.set(item.key, item);
    void this.drain();
  }

  cancel(key: string): void {
    this.pending.delete(key);
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.size > 0) {
        const key =
          this.activeKey && this.pending.has(this.activeKey) ? this.activeKey : this.pending.keys().next().value!;
        const item = this.pending.get(key)!;
        this.pending.delete(key);
        try {
          await item.execute();
        } catch {
          // errors are reported by the job itself
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export interface RefreshSchedulerOptions {
  key: string;
  queue: RefreshQueue;
  /** The refresh itself (status computation). */
  run: (reasons: ReadonlySet<RefreshReason>) => Promise<void>;
  clock?: SchedulerClock;
  debounceMs?: number;
  maxWaitMs?: number;
}

/**
 * Debounced, single-flight refreshes of one repository: trailing debounce 250 ms with a 1 s max wait, one run
 * at a time (requests during a run cause exactly one follow-up), and a debounce that grows to 2× the last run
 * time (max 5 s) for slow repositories.
 */
export class RefreshScheduler {
  private readonly clock: SchedulerClock;
  private readonly baseDebounce: number;
  private readonly maxWait: number;
  private debounce: number;
  private timer: unknown;
  private firstRequestAt: number | null = null;
  private reasons = new Set<RefreshReason>();
  private running = false;
  private queued = false;
  private dirty = false;
  private disposed = false;
  /** Number of completed runs (diagnostics, tests). */
  runs = 0;
  lastDurationMs = 0;

  constructor(private readonly o: RefreshSchedulerOptions) {
    this.clock = o.clock ?? realClock;
    this.baseDebounce = o.debounceMs ?? 250;
    this.maxWait = o.maxWaitMs ?? 1000;
    this.debounce = this.baseDebounce;
  }

  get currentDebounceMs(): number {
    return this.debounce;
  }

  request(reason: RefreshReason): void {
    if (this.disposed) return;
    this.reasons.add(reason);
    if (this.running || this.queued) {
      this.dirty = true;
      return;
    }
    const now = this.clock.now();
    this.firstRequestAt ??= now;
    // Explicit refreshes (button, window focus, first load) skip the debounce.
    const immediate = reason === 'manual' || reason === 'focus' || reason === 'initial';
    const wait = immediate ? 0 : Math.max(0, Math.min(this.debounce, this.firstRequestAt + this.maxWait - now));
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.fire(), wait);
  }

  private fire(): void {
    this.timer = undefined;
    this.firstRequestAt = null;
    this.queued = true;
    this.o.queue.enqueue({ key: this.o.key, execute: () => this.execute() });
  }

  private async execute(): Promise<void> {
    this.queued = false;
    if (this.disposed) return;
    const reasons = this.reasons;
    this.reasons = new Set();
    this.running = true;
    const started = this.clock.now();
    try {
      await this.o.run(reasons);
    } finally {
      this.running = false;
      this.runs++;
      this.lastDurationMs = this.clock.now() - started;
      this.debounce = this.lastDurationMs > 500 ? Math.min(5000, 2 * this.lastDurationMs) : this.baseDebounce;
      if (this.dirty) {
        this.dirty = false;
        const again = [...this.reasons];
        this.reasons = new Set();
        for (const r of again.length > 0 ? again : (['fs'] as RefreshReason[])) this.request(r);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.o.queue.cancel(this.o.key);
  }
}
