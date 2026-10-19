import { afterEach, expect, it, vi } from 'vitest';
import { Emitter } from '@shared/utils/emitter';
import { CodeMapActivityHints } from './activity-hints';

afterEach(() => vi.useRealTimers());
it('coalesces activity hints, reconciles after restarts and never starts a stopped host', async () => {
  vi.useFakeTimers();
  type Host = ConstructorParameters<typeof CodeMapActivityHints>[0]['host'];
  const ready = new Emitter<{ pid: number; restarted: boolean }>(),
    changed = new Emitter<void>();
  const call = vi.fn<Host['call']>().mockResolvedValue(null);
  const host: Host = { state: 'stopped', call, onDidBecomeReady: ready.event };
  const current = vi.fn(() => ({ activeProjectId: 'active', terminalProjectIds: ['active', 'background'] }));
  const hints = new CodeMapActivityHints({
    host,
    current,
    subscribe: (listener) => [changed.event(listener)],
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  });
  changed.fire();
  await vi.advanceTimersByTimeAsync(1000);
  expect(call).not.toHaveBeenCalled();
  Object.assign(host, { state: 'running' });
  ready.fire({ pid: 1, restarted: true });
  expect(call).toHaveBeenLastCalledWith('hints:update', {
    activeProjectId: 'active',
    terminalProjectIds: ['active', 'background'],
    reconcile: true,
  });
  changed.fire();
  changed.fire();
  await vi.advanceTimersByTimeAsync(101);
  expect(call).toHaveBeenCalledTimes(2);
  hints.dispose();
  changed.fire();
  await vi.advanceTimersByTimeAsync(1000);
  expect(call).toHaveBeenCalledTimes(2);
});
