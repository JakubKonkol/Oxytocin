import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefreshQueue, RefreshScheduler, type RefreshReason } from './refresh-scheduler';

afterEach(() => vi.useRealTimers());

function setup(runMs = 10) {
  vi.useFakeTimers();
  const runs: { at: number; reasons: RefreshReason[] }[] = [];
  const queue = new RefreshQueue();
  const scheduler = new RefreshScheduler({
    key: 'p',
    queue,
    run: async (reasons) => {
      runs.push({ at: Date.now(), reasons: [...reasons] });
      await new Promise((r) => setTimeout(r, runMs));
    },
  });
  return { scheduler, runs, queue, start: Date.now() };
}

describe('RefreshScheduler', () => {
  it('debounces bursts (trailing 250 ms)', async () => {
    const { scheduler, runs, start } = setup();
    scheduler.request('fs');
    await vi.advanceTimersByTimeAsync(100);
    scheduler.request('fs');
    await vi.advanceTimersByTimeAsync(249);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.at - start).toBe(350);
  });

  it('refreshes at least every second under a continuous stream (maxWait)', async () => {
    const { scheduler, runs, start } = setup();
    for (let t = 0; t < 2500; t += 100) {
      scheduler.request('fs');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(runs.map((r) => r.at - start)).toEqual([1000, 2010]);
  });

  it('is single-flight: requests during a run cause exactly one follow-up', async () => {
    const { scheduler, runs } = setup(400);
    scheduler.request('manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(1);
    scheduler.request('fs');
    scheduler.request('gitdir');
    scheduler.request('fs');
    await vi.advanceTimersByTimeAsync(400 + 250);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.reasons.sort()).toEqual(['fs', 'gitdir']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toHaveLength(2);
  });

  it('adapts the debounce to slow repositories', async () => {
    const { scheduler } = setup(800);
    scheduler.request('manual');
    await vi.advanceTimersByTimeAsync(800);
    expect(scheduler.currentDebounceMs).toBe(1600);
    const fast = setup(3000);
    fast.scheduler.request('manual');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fast.scheduler.currentDebounceMs).toBe(5000);
  });

  it('runs explicit refreshes immediately and the active project first', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const queue = new RefreshQueue();
    const make = (key: string) =>
      new RefreshScheduler({
        key,
        queue,
        run: async () => {
          order.push(key);
          await new Promise((r) => setTimeout(r, 50));
        },
      });
    const [a, b, c] = [make('a'), make('b'), make('c')];
    a.request('manual');
    await vi.advanceTimersByTimeAsync(0); // a runs (50 ms)
    b.request('manual');
    c.request('manual');
    queue.setActive('c');
    await vi.advanceTimersByTimeAsync(200);
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('stops after dispose', async () => {
    const { scheduler, runs } = setup();
    scheduler.request('fs');
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toHaveLength(0);
  });
});
