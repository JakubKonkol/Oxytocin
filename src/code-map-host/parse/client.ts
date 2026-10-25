import { Worker } from 'node:worker_threads';
import { ParseJobSchema, ParseResultSchema, type FileRecord } from '../extract/record';
import { CodeMapLimitError } from '../enumerate';

/** One reusable parser thread. Its deadline remains enforceable when WASM blocks its event loop. */
export class ParserClient {
  private worker: Worker | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private id = 0;
  private closed = false;
  constructor(
    private readonly entry: string,
    private readonly assets: string,
    private readonly timeoutMs = 2500,
  ) {}
  parse(path: string, source: string, signal?: AbortSignal): Promise<FileRecord> {
    const result = this.serial.then(() => this.parseNow(path, source, signal));
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async parseNow(path: string, source: string, signal?: AbortSignal): Promise<FileRecord> {
    if (this.closed) throw new Error('Code Map parser has been disposed');
    signal?.throwIfAborted();
    const job = ParseJobSchema.parse({ id: ++this.id, path, source });
    if (!this.worker) {
      const created = new Worker(this.entry, {
        workerData: { assets: this.assets },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      });
      created.on('error', () => {
        if (this.worker === created) this.worker = undefined;
      });
      created.on('exit', () => {
        if (this.worker === created) this.worker = undefined;
      });
      this.worker = created;
    }
    const worker = this.worker;
    // A file the worker turned down for its size (LIMIT) leaves it healthy and its grammars loaded; any other
    // failure (deadline, cancellation, crash, parse error) starts a fresh thread for the next file.
    let healthy = false;
    try {
      return await new Promise<FileRecord>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Code Map parser deadline exceeded')), this.timeoutMs);
        const abort = () => reject(new Error('Code Map parsing cancelled'));
        const fail = (error: Error) => reject(error);
        const exit = () => reject(new Error('Code Map parser stopped before producing a result'));
        const receive = (input: unknown) => {
          try {
            const result = ParseResultSchema.parse(input);
            if (result.id !== job.id) throw new Error('Unexpected Code Map parser response');
            if ('error' in result) {
              healthy = result.code === 'LIMIT';
              reject(result.code === 'LIMIT' ? new CodeMapLimitError(result.error) : new Error(result.error));
            } else resolve(result.record);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          worker.off('message', receive);
          worker.off('error', fail);
          worker.off('exit', exit);
        };
        worker.once('message', receive);
        worker.once('error', fail);
        worker.once('exit', exit);
        signal?.addEventListener('abort', abort, { once: true });
        // Cleanup is attached before posting so even a postMessage failure releases the deadline.
        this.cleanup = cleanup;
        worker.postMessage(job);
      });
    } catch (error) {
      if (!healthy) await this.reset();
      throw error;
    } finally {
      this.cleanup?.();
      this.cleanup = undefined;
    }
  }
  private cleanup: (() => void) | undefined;
  private async reset(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await this.reset();
  }
}
