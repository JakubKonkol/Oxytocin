import { type AgentLimits, AgentLimitsSchema } from '@shared/domain/agent-limits';
import { OxyError } from '@shared/errors';
import type { Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

/**
 * The latest plan limits of each agent account, as reported by plugins (the Usage Monitor). Kept in memory: the
 * reporting plugin knows them again after a restart.
 */
export class AgentLimitsStore implements Disposable {
  private readonly byAccount = new Map<string, AgentLimits>();
  private readonly emitter = new Emitter<AgentLimits[]>();
  readonly onDidChange = this.emitter.event;

  list(): AgentLimits[] {
    return [...this.byAccount.values()];
  }

  report(raw: unknown): void {
    const parsed = AgentLimitsSchema.safeParse(raw);
    if (!parsed.success) throw new OxyError('INVALID', `Invalid limits: ${parsed.error.issues[0]?.message ?? ''}`);
    const key = `${parsed.data.agent}/${parsed.data.accountId}`;
    const previous = this.byAccount.get(key);
    // Newer readings only, window by window: two sources must not move a window back in time.
    const windows = new Map((previous?.windows ?? []).map((w) => [w.window, w]));
    for (const w of parsed.data.windows) {
      const old = windows.get(w.window);
      if (!old || w.observedAt >= old.observedAt) windows.set(w.window, w);
    }
    const next: AgentLimits = { ...parsed.data, windows: [...windows.values()] };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.byAccount.set(key, next);
    this.emitter.fire(this.list());
  }

  /** Forgets accounts that no longer exist. */
  retain(keys: ReadonlySet<string>): void {
    let changed = false;
    for (const key of [...this.byAccount.keys()])
      if (!keys.has(key)) {
        this.byAccount.delete(key);
        changed = true;
      }
    if (changed) this.emitter.fire(this.list());
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
