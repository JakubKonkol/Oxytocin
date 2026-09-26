/** Minimal request/response + events protocol between the plugin's main thread and its worker thread. */
export type WorkerRequest = { id: number; method: string; params: unknown };
export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type WorkerEvent = { event: string; payload: unknown };
export type WorkerMessage = WorkerResponse | WorkerEvent;

export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

/** Worker side: answers requests with the given handlers; returns an event emitter function. */
export function serveWorker(
  port: PortLike,
  handlers: Record<string, (params: never) => unknown>,
): (event: string, payload: unknown) => void {
  port.on('message', (raw) => {
    const req = raw as WorkerRequest;
    const handler = handlers[req.method];
    void Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`Unknown method ${req.method}`);
        return handler(req.params as never);
      })
      .then(
        (result) => port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse),
        (e: unknown) =>
          port.postMessage({
            id: req.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          } satisfies WorkerResponse),
      );
  });
  return (event, payload) => port.postMessage({ event, payload } satisfies WorkerEvent);
}

/** Main-thread side. */
export class WorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(event: string, payload: unknown) => void>();

  constructor(private readonly port: PortLike) {
    port.on('message', (raw) => {
      const m = raw as WorkerMessage;
      if ('event' in m) {
        for (const l of [...this.listeners]) l(m.event, m.payload);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ id, method, params } satisfies WorkerRequest);
    });
  }

  onEvent(listener: (event: string, payload: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rejects outstanding requests (worker exited). */
  failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
