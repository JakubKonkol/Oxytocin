import type { Learning, MemoryAuthority } from '@shared/domain/code-map-memory';
import { CodeMapWatch, type WatchSubscribe } from '../watch';

/** The reverse index receives raw watcher events, independently of parser/rebuild scheduling. */
export class EvidenceObservation {
  private readonly entries = new Map<
    string,
    {
      watcher: CodeMapWatch;
      root: string;
      epoch: number;
      paths: Map<string, Set<string>>;
      invalid: Set<string>;
    }
  >();
  constructor(private readonly subscribe?: WatchSubscribe) {}
  async observe(authority: MemoryAuthority, records: Learning[], changed: () => void): Promise<void> {
    if (authority.archived) return;
    let entry = this.entries.get(authority.checkoutId);
    if (entry && entry.root !== authority.root) {
      await entry.watcher.close();
      this.entries.delete(authority.checkoutId);
      entry = undefined;
    }
    if (!entry) {
      const value = {
        root: authority.root,
        epoch: 0,
        paths: new Map<string, Set<string>>(),
        invalid: new Set<string>(),
        watcher: undefined as unknown as CodeMapWatch,
      };
      value.watcher = new CodeMapWatch(
        authority.root,
        ({ paths, reconcile }) => {
          value.epoch++;
          for (const [evidence, ids] of value.paths)
            if ((!paths.length && reconcile) || paths.some((p) => p === evidence || evidence.startsWith(`${p}/`)))
              for (const id of ids) value.invalid.add(id);
          if (value.invalid.size) changed();
        },
        this.subscribe,
      );
      this.entries.set(authority.checkoutId, value);
      try {
        await value.watcher.start();
      } catch (error) {
        this.entries.delete(authority.checkoutId);
        throw new Error('MEMORY_UNAVAILABLE: evidence watcher failed', { cause: error });
      }
      entry = value;
    }
    entry.paths.clear();
    for (const record of records)
      if (record.review === 'accepted' && (record.checkoutId === authority.checkoutId || record.scope === 'project'))
        for (const evidence of record.evidence) {
          const ids = entry.paths.get(evidence.path) ?? new Set<string>();
          ids.add(record.id);
          entry.paths.set(evidence.path, ids);
        }
  }
  epoch(checkoutId: string): number {
    return this.entries.get(checkoutId)?.epoch ?? 0;
  }
  invalid(checkoutId: string, id: string): boolean {
    return this.entries.get(checkoutId)?.invalid.has(id) ?? false;
  }
  reviewed(checkoutId: string, id: string): void {
    this.entries.get(checkoutId)?.invalid.delete(id);
  }
  async remove(checkoutId: string): Promise<void> {
    const entry = this.entries.get(checkoutId);
    this.entries.delete(checkoutId);
    await entry?.watcher.close();
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
  }
}
