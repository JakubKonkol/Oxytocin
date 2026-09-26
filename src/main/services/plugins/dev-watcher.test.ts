import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginDescriptor } from '@shared/domain/plugin';
import { DevPluginWatcher, type WatchFn } from './dev-watcher';

afterEach(() => vi.useRealTimers());

const plugin = (id: string, source: PluginDescriptor['source'], path = `/p/${id}`) =>
  ({
    id,
    source,
    path,
    version: '1.0.0',
    displayName: id,
    state: 'enabled',
    permissions: [],
  }) as unknown as PluginDescriptor;

function setup() {
  const listeners = new Map<string, (event: string, filename: string | null) => void>();
  const closed: string[] = [];
  const watch: WatchFn = (path, _o, listener) => {
    listeners.set(path, listener);
    return { close: () => closed.push(path), on: () => undefined as never };
  };
  const reload = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const watcher = new DevPluginWatcher(reload, logger, watch);
  return { watcher, listeners, closed, reload };
}

describe('DevPluginWatcher', () => {
  it('watches dev plugins only and reloads once after changes settle', () => {
    vi.useFakeTimers();
    const s = setup();
    s.watcher.update([plugin('a', 'dev'), plugin('b', 'builtin')], true);
    expect([...s.listeners.keys()]).toEqual(['/p/a']);
    const fire = s.listeners.get('/p/a')!;
    fire('change', 'dist/host.js');
    vi.advanceTimersByTime(200);
    fire('change', 'dist/views/main.js');
    vi.advanceTimersByTime(299);
    expect(s.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.reload).toHaveBeenCalledExactlyOnceWith('a');
    // Sources and dependencies are ignored.
    fire('change', 'src/host.ts');
    fire('change', 'node_modules/x/index.js');
    vi.advanceTimersByTime(1000);
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('stops watching when developer mode is off or the plugin moved', () => {
    const s = setup();
    s.watcher.update([plugin('a', 'dev')], true);
    s.watcher.update([plugin('a', 'dev', '/elsewhere')], true);
    expect(s.closed).toEqual(['/p/a']);
    expect(s.listeners.has('/elsewhere')).toBe(true);
    s.watcher.update([plugin('a', 'dev', '/elsewhere')], false);
    expect(s.closed).toEqual(['/p/a', '/elsewhere']);
  });
});
