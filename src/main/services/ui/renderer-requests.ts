import { randomUUID } from 'node:crypto';

/**
 * Round-trips requests the window answers (a confirmation dialog, a notification's buttons). A request resolves
 * with the answer, or null when nobody can answer: no loaded window, the renderer reloaded or went away, or
 * `timeoutMs` passed.
 */
export class RendererRequests<TRequest extends { requestId: string }, TAnswer> {
  private readonly pending = new Map<string, (answer: TAnswer | null) => void>();

  /** `send` returns false when there is no window to ask. */
  constructor(
    private readonly send: (request: TRequest) => boolean,
    private readonly timeoutMs = 0,
  ) {}

  ask(request: Omit<TRequest, 'requestId'>): Promise<TAnswer | null> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = this.timeoutMs > 0 ? setTimeout(() => this.settle(requestId, null), this.timeoutMs) : undefined;
      this.pending.set(requestId, (answer) => {
        if (timer) clearTimeout(timer);
        resolve(answer);
      });
      if (!this.send({ ...request, requestId } as TRequest)) this.settle(requestId, null);
    });
  }

  settle(requestId: string, answer: TAnswer | null): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve(answer);
  }

  /** The renderer reloaded or closed: nobody will answer. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }

  get size(): number {
    return this.pending.size;
  }
}
