import { Worker } from 'node:worker_threads';
import { type RenderedPreview, type RenderFailure, renderPreview, toFailure } from './render-preview';

/** A render error from the worker, with the details of `RenderFailure`. */
export class RenderError extends Error {
  constructor(readonly failure: RenderFailure) {
    super(failure.message);
  }
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error' | 'exit', listener: (arg: unknown) => void): unknown;
  terminate(): Promise<number>;
}

type Pending = {
  resolve: (r: RenderedPreview) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Renders previews in one worker thread, started on first use. A render that takes longer than `timeoutMs` ends the
 * worker (a new one starts for the next render); a crashed worker fails its pending renders.
 */
export class RenderPool {
  private worker: WorkerLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly createWorker: (() => WorkerLike) | null = () =>
      new Worker(new URL('./workers/render.js', import.meta.url)),
    private readonly timeoutMs = 20_000,
  ) {}

  render(filePath: string, rootPath: string): Promise<RenderedPreview> {
    // No worker (tests, a missing bundle): render on this thread.
    if (!this.createWorker) return renderPreview(filePath, rootPath).catch(wrap);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset(new Error('Rendering the file took too long. Open it in the editor.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, filePath, rootPath });
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker!();
    worker.on('message', (raw) => {
      const m = raw as
        { id: number; ok: true; result: RenderedPreview } | { id: number; ok: false; error: RenderFailure };
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new RenderError(m.error));
    });
    worker.on('error', (e) => this.reset(e instanceof Error ? e : new Error(String(e)), worker));
    worker.on('exit', () => this.reset(new Error('The preview renderer stopped.'), worker));
    this.worker = worker;
    return worker;
  }

  /** Fails every pending render and drops the worker (the next render starts a new one). */
  private reset(error: Error, which?: WorkerLike): void {
    if (which && which !== this.worker) return;
    const worker = this.worker;
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    void worker?.terminate().catch(() => undefined);
  }

  dispose(): void {
    this.reset(new Error('The preview was closed.'));
  }
}

function wrap(e: unknown): never {
  throw new RenderError(toFailure(e));
}
