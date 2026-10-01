import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@shared/logging/logger';
import { RendererRecovery, type RendererRecoveryOptions } from './renderer-recovery';

const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function setup(over: Partial<RendererRecoveryOptions> = {}) {
  let now = 0;
  const timers: { fn: () => void; ms: number; disposed: boolean }[] = [];
  const reload = vi.fn();
  const quit = vi.fn();
  let destroyed = false;
  const recovery = new RendererRecovery({
    isDestroyed: () => destroyed,
    reload,
    quit,
    askAfterCrashes: vi.fn(() => Promise.resolve('reload' as const)),
    askWhenUnresponsive: vi.fn(() => Promise.resolve('wait' as const)),
    logger,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, disposed: false };
      timers.push(t);
      return { dispose: () => (t.disposed = true) };
    },
    ...over,
  });
  const runTimers = () => {
    for (const t of timers.splice(0)) if (!t.disposed) t.fn();
  };
  return {
    recovery,
    reload,
    quit,
    timers,
    runTimers,
    advance: (ms: number) => (now += ms),
    destroy: () => (destroyed = true),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RendererRecovery', () => {
  it('reloads a crashed renderer after a short delay', () => {
    const s = setup();
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    expect(s.reload).not.toHaveBeenCalled();
    expect(s.timers[0]?.ms).toBe(500);
    s.runTimers();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a clean exit and a destroyed window', () => {
    const s = setup();
    s.recovery.onGone({ reason: 'clean-exit', exitCode: 0 });
    expect(s.timers).toHaveLength(0);
    s.destroy();
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    expect(s.timers).toHaveLength(0);
  });

  it('does not reload when the window is destroyed before the delay ends', () => {
    const s = setup();
    s.recovery.onGone({ reason: 'oom', exitCode: 1 });
    s.destroy();
    s.runTimers();
    expect(s.reload).not.toHaveBeenCalled();
  });

  it('asks the user after repeated crashes instead of reloading forever', async () => {
    const askAfterCrashes = vi.fn(() => Promise.resolve('quit' as const));
    const s = setup({ askAfterCrashes });
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.runTimers();
    s.advance(1000);
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.runTimers();
    s.advance(1000);
    s.recovery.onGone({ reason: 'killed', exitCode: 9 });
    expect(s.timers).toHaveLength(0);
    expect(askAfterCrashes).toHaveBeenCalledWith(3);
    await flush();
    expect(s.quit).toHaveBeenCalledTimes(1);
    expect(s.reload).toHaveBeenCalledTimes(2);
  });

  it('reloads and starts counting again when the user chooses to reload', async () => {
    const askAfterCrashes = vi.fn(() => Promise.resolve('reload' as const));
    const s = setup({ askAfterCrashes, maxCrashes: 2 });
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.runTimers();
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(2);
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    expect(askAfterCrashes).toHaveBeenCalledTimes(1);
    expect(s.timers).toHaveLength(1);
  });

  it('forgets crashes older than the crash window', () => {
    const askAfterCrashes = vi.fn(() => Promise.resolve('reload' as const));
    const s = setup({ askAfterCrashes, maxCrashes: 2, crashWindowMs: 10_000 });
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.runTimers();
    s.advance(20_000);
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.runTimers();
    expect(askAfterCrashes).not.toHaveBeenCalled();
    expect(s.reload).toHaveBeenCalledTimes(2);
  });

  it('offers a reload when the window hangs and reloads on request', async () => {
    const askWhenUnresponsive = vi.fn(() => Promise.resolve('reload' as const));
    const s = setup({ askWhenUnresponsive });
    s.recovery.onUnresponsive();
    s.recovery.onUnresponsive();
    expect(askWhenUnresponsive).toHaveBeenCalledTimes(1);
    await flush();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('closes the hang dialog and ignores its answer when the window responds again', async () => {
    let signal: AbortSignal | undefined;
    let answer: (choice: 'reload' | 'wait') => void = () => undefined;
    const askWhenUnresponsive = vi.fn(
      (s: AbortSignal) =>
        new Promise<'reload' | 'wait'>((resolve) => {
          signal = s;
          answer = resolve;
        }),
    );
    const s = setup({ askWhenUnresponsive });
    s.recovery.onUnresponsive();
    s.recovery.onResponsive();
    expect(signal?.aborted).toBe(true);
    answer('reload');
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    // A later hang asks again.
    s.recovery.onUnresponsive();
    expect(askWhenUnresponsive).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending reload when disposed', () => {
    const s = setup();
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    s.recovery.dispose();
    s.runTimers();
    expect(s.reload).not.toHaveBeenCalled();
  });

  it('survives a reload that throws', () => {
    const s = setup({
      reload: () => {
        throw new Error('Object has been destroyed');
      },
    });
    s.recovery.onGone({ reason: 'crashed', exitCode: 1 });
    expect(() => s.runTimers()).not.toThrow();
  });
});
