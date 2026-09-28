import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderError, RenderPool, type WorkerLike } from './render-pool';

/** A worker that answers on demand. */
function fakeWorker() {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const posted: { id: number; filePath: string }[] = [];
  const terminate = vi.fn(() => Promise.resolve(0));
  const worker: WorkerLike = {
    postMessage: (m) => void posted.push(m as { id: number; filePath: string }),
    on: (event: string, l: (arg: unknown) => void) => {
      (listeners[event] ??= []).push(l);
      return worker;
    },
    terminate,
  };
  const emit = (event: string, arg: unknown) => listeners[event]?.forEach((l) => l(arg));
  return { worker, posted, emit, terminate };
}

afterEach(() => vi.useRealTimers());

describe('RenderPool', () => {
  it('renders on this thread without a worker and reports missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-pool-'));
    await writeFile(join(dir, 'a.ts'), 'const a = 1;\n');
    const pool = new RenderPool(null);
    await expect(pool.render(join(dir, 'a.ts'), dir)).resolves.toMatchObject({ kind: 'code' });
    const missing = await pool.render(join(dir, 'gone.md'), dir).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(RenderError);
    expect((missing as RenderError).failure.code).toBe('ENOENT');
  });

  it('answers renders from the worker and passes failures on', async () => {
    const f = fakeWorker();
    const pool = new RenderPool(() => f.worker);
    const first = pool.render('/p/a.md', '/p');
    const second = pool.render('/p/big.log', '/p');
    f.emit('message', { id: f.posted[1]!.id, ok: false, error: { message: 'too large', expected: true } });
    f.emit('message', { id: f.posted[0]!.id, ok: true, result: { html: '<h1>A</h1>', kind: 'markdown' } });
    await expect(first).resolves.toEqual({ html: '<h1>A</h1>', kind: 'markdown' });
    await expect(second).rejects.toMatchObject({ failure: { message: 'too large', expected: true } });
  });

  it('ends a worker that takes too long and starts a new one for the next render', async () => {
    vi.useFakeTimers();
    const workers = [fakeWorker(), fakeWorker()];
    let n = 0;
    const pool = new RenderPool(() => workers[n++]!.worker, 1000);
    const slow = pool.render('/p/huge.ts', '/p');
    const failed = expect(slow).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
    expect(workers[0]!.terminate).toHaveBeenCalled();
    const next = pool.render('/p/a.ts', '/p');
    workers[1]!.emit('message', { id: workers[1]!.posted[0]!.id, ok: true, result: { html: 'x', kind: 'code' } });
    await expect(next).resolves.toMatchObject({ html: 'x' });
    // A crash fails the pending renders.
    const pending = pool.render('/p/b.ts', '/p');
    workers[1]!.emit('error', new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
    pool.dispose();
  });
});
