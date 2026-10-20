import type { Disposable } from '@shared/utils/disposable';

export interface BuildRequest {
  paths: string[];
  reconcile: boolean;
  fullHash: boolean;
}
interface Pending {
  paths: Set<string>;
  reconcile: boolean;
  fullHash: boolean;
  ready: boolean;
  order: number;
  since: number;
}
interface Task {
  projectId: string;
  run: (request: BuildRequest, signal: AbortSignal) => Promise<void>;
  error: (error: unknown) => void;
  paused: boolean;
  queriedUntil?: number;
  pending?: Pending;
  quiet?: ReturnType<typeof setTimeout>;
  maximum?: ReturnType<typeof setTimeout>;
}

/** One build globally, bounded debounce, and fair selection between projects. */
export class CodeMapScheduler implements Disposable {
  private readonly tasks = new Map<string, Task>();
  private activeProjectId: string | null = null;
  private terminals = new Set<string>();
  private order = 0;
  private running: { id: string; controller: AbortController } | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  register(id: string, projectId: string, run: Task['run'], error: Task['error']): void {
    this.tasks.set(id, { projectId, run, error, paused: false });
  }
  hints(activeProjectId: string | null, terminalProjectIds: readonly string[]): void {
    this.activeProjectId = activeProjectId;
    this.terminals = new Set(terminalProjectIds);
  }
  isActive(projectId: string): boolean {
    return projectId === this.activeProjectId || this.terminals.has(projectId);
  }
  request(id: string, options: Partial<BuildRequest> & { immediate?: boolean; forQuery?: boolean } = {}): void {
    const task = this.tasks.get(id);
    if (!task || this.disposed) return;
    if (options.forQuery) task.queriedUntil = Date.now() + 2000;
    const pending = (task.pending ??= {
      paths: new Set(),
      reconcile: false,
      fullHash: false,
      ready: false,
      order: ++this.order,
      since: Date.now(),
    });
    for (const path of options.paths ?? []) {
      if (pending.paths.size < 500) pending.paths.add(path);
      else pending.reconcile = true;
    }
    pending.reconcile ||= !!options.reconcile;
    pending.fullHash ||= !!options.fullHash;
    if (task.paused) return;
    if (options.immediate || pending.ready) {
      this.ready(id, task);
      return;
    }
    if (task.quiet) clearTimeout(task.quiet);
    task.quiet = setTimeout(() => this.ready(id, task), 300);
    task.maximum ??= setTimeout(() => this.ready(id, task), 2000);
  }
  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.paused = true;
    this.clearTimers(task);
    if (this.running?.id === id) this.running.controller.abort();
  }
  resume(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.paused = false;
    this.request(id, { immediate: true, reconcile: true, fullHash: true });
  }
  remove(id: string): void {
    this.pause(id);
    this.tasks.delete(id);
  }
  private clearTimers(task: Task): void {
    if (task.quiet) clearTimeout(task.quiet);
    if (task.maximum) clearTimeout(task.maximum);
    task.quiet = task.maximum = undefined;
  }
  private ready(id: string, task: Task): void {
    if (!this.tasks.has(id) || task.paused || !task.pending) return;
    this.clearTimers(task);
    task.pending.ready = true;
    this.drainTimer ??= setTimeout(() => {
      this.drainTimer = undefined;
      void this.drain();
    }, 0);
  }
  private priority(task: Task): number {
    if ((task.queriedUntil ?? 0) > Date.now()) return -1;
    if (Date.now() - task.pending!.since > 10_000) return 0;
    return task.projectId === this.activeProjectId ? 0 : this.terminals.has(task.projectId) ? 1 : 2;
  }
  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    const next = [...this.tasks]
      .filter(([, task]) => !task.paused && task.pending?.ready)
      .sort(
        ([, left], [, right]) =>
          this.priority(left) - this.priority(right) || left.pending!.order - right.pending!.order,
      )[0];
    if (!next) return;
    const [id, task] = next;
    const pending = task.pending!;
    task.pending = undefined;
    const controller = new AbortController();
    this.running = { id, controller };
    try {
      await task.run(
        { paths: [...pending.paths].sort(), reconcile: pending.reconcile, fullHash: pending.fullHash },
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) task.error(error);
    } finally {
      this.running = undefined;
      if (!this.disposed) void this.drain();
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    for (const id of this.tasks.keys()) this.remove(id);
    this.tasks.clear();
  }
}
