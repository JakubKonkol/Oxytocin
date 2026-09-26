import type { ProjectRuntimeStatus } from '@shared/domain/activity';
import type { TerminalInfo } from '@shared/domain/terminal';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { runtimeStatus } from './activity';

export interface ActivityTerminalsPort {
  list(): TerminalInfo[];
  onDidUpdate: (listener: (info: TerminalInfo) => void) => Disposable;
  onDidRemove: (listener: (id: string) => void) => Disposable;
}

/**
 * Aggregates terminals into per-project runtime status (activity dot, counters) and emits only the projects
 * whose status changed, debounced by 100 ms.
 */
export class ActivityService implements Disposable {
  private readonly seen = new Set<string>();
  private readonly exitedAt = new Map<string, number>();
  private readonly last = new Map<string, string>();
  private readonly store = new DisposableStore();
  private readonly emitter = new Emitter<ProjectRuntimeStatus[]>();
  readonly onDidChange = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly terminals: ActivityTerminalsPort,
    private readonly projectIds: () => string[],
    private readonly debounceMs = 100,
  ) {
    this.store.add(
      terminals.onDidUpdate((info) => {
        if (info.state !== 'running' && !this.exitedAt.has(info.id)) this.exitedAt.set(info.id, Date.now());
        this.schedule();
      }),
    );
    this.store.add(
      terminals.onDidRemove((id) => {
        this.seen.delete(id);
        this.exitedAt.delete(id);
        this.schedule();
      }),
    );
  }

  /** The user looked at an exited terminal (focused and visible ≥ 1 s): its error no longer marks the project. */
  markSeen(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.schedule();
  }

  list(): ProjectRuntimeStatus[] {
    const all = this.terminals.list();
    const ids = new Set([...this.projectIds(), ...all.map((t) => t.projectId)]);
    return [...ids].map((id) =>
      runtimeStatus(
        id,
        all.filter((t) => t.projectId === id),
        this.seen,
        this.exitedAt,
      ),
    );
  }

  /** Recomputes now; returns (and emits) the changed statuses. */
  flush(): ProjectRuntimeStatus[] {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const changed: ProjectRuntimeStatus[] = [];
    for (const status of this.list()) {
      const key = JSON.stringify(status);
      if (this.last.get(status.projectId) === key) continue;
      this.last.set(status.projectId, key);
      changed.push(status);
    }
    if (changed.length > 0) this.emitter.fire(changed);
    return changed;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.store.dispose();
    this.emitter.dispose();
  }
}
