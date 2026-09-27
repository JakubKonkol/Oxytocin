import { randomUUID } from 'node:crypto';
import type { QuickPickItem, QuickPickRequest } from '@shared/domain/quick-pick';

/**
 * Round-trips quick picks to the renderer's command palette (`oxy.ui.showQuickPick`). A pick resolves with the
 * chosen index, or null when it was dismissed, replaced by another pick, or the window went away.
 */
export class QuickPickBroker {
  private readonly pending = new Map<string, (index: number | null) => void>();

  /** `send` returns false when there is no window to show the pick in. */
  constructor(private readonly send: (request: QuickPickRequest) => boolean) {}

  show(items: QuickPickItem[], options: { placeholder?: string; source?: string } = {}): Promise<number | null> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      const sent = this.send({
        requestId,
        items,
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
        ...(options.source ? { source: options.source } : {}),
      });
      if (!sent) this.settle(requestId, null);
    });
  }

  settle(requestId: string, index: number | null): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve(index);
  }

  /** The renderer reloaded or closed: nobody will answer. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }

  get size(): number {
    return this.pending.size;
  }
}
