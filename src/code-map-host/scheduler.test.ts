import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeMapScheduler, type BuildRequest } from './scheduler';

let scheduler: CodeMapScheduler;
beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new CodeMapScheduler();
});
afterEach(() => {
  scheduler.dispose();
  vi.useRealTimers();
});

describe('Code Map scheduling', () => {
  it('debounces by 300 ms of quiet and merges a branch-sized batch', async () => {
    const run = vi.fn<(request: BuildRequest) => Promise<void>>().mockResolvedValue();
    scheduler.register('checkout', 'project', run, vi.fn());
    scheduler.request('checkout', { paths: ['first.ts'] });
    await vi.advanceTimersByTimeAsync(200);
    scheduler.request('checkout', { paths: Array.from({ length: 5000 }, (_, index) => `src/${index}.ts`) });
    await vi.advanceTimersByTimeAsync(299);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].reconcile).toBe(true);
    expect(run.mock.calls[0]![0].paths.length).toBeLessThanOrEqual(500);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('never postpones continuous edits past the two-second maximum', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduler.register('c', 'p', run, vi.fn());
    for (let index = 0; index < 8; index++) {
      scheduler.request('c', { paths: [`${index}.ts`] });
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('prioritizes the active project without cancelling a running build', async () => {
    const order: string[] = [];
    scheduler.hints('active', []);
    for (const project of ['background', 'active']) {
      scheduler.register(
        project,
        project,
        () => {
          order.push(project);
          return Promise.resolve();
        },
        vi.fn(),
      );
      scheduler.request(project, { immediate: true });
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['active', 'background']);
  });
  it('buffers newer changes for the next pass and supports pause, resume and removal', async () => {
    let release: (() => void) | undefined;
    const signals: AbortSignal[] = [];
    const run = vi.fn((_: BuildRequest, signal: AbortSignal) => {
      signals.push(signal);
      return run.mock.calls.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    });
    scheduler.register('c', 'p', run, vi.fn());
    scheduler.request('c', { immediate: true });
    await vi.advanceTimersByTimeAsync(1);
    scheduler.request('c', { paths: ['later.ts'] });
    await vi.advanceTimersByTimeAsync(301);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false);
    release!();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].paths).toEqual(['later.ts']);
    scheduler.pause('c');
    scheduler.request('c', { paths: ['paused.ts'] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.resume('c');
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.remove('c');
    scheduler.request('c', { immediate: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
