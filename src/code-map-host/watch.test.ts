import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodeMapWatch, type WatchSubscribe } from './watch';

describe('Code Map watcher checkpoints', () => {
  it('keeps edits newer than the published sequence and ignores its own artifacts', async () => {
    const root = resolve('virtual-repo');
    let receive: Parameters<WatchSubscribe>[1] | undefined;
    const unsubscribe = vi.fn().mockResolvedValue(undefined),
      changed = vi.fn();
    const watch = new CodeMapWatch(root, changed, (_, callback) => {
      receive = callback;
      return Promise.resolve({ unsubscribe });
    });
    await watch.start();
    receive!(null, [{ path: join(root, 'a.ts'), type: 'create' }]);
    const first = watch.checkpoint();
    receive!(null, [
      { path: join(root, 'a.ts'), type: 'update' },
      { path: join(root, '.oxy/code-map/graph.json'), type: 'update' },
      { path: join(root, '.env'), type: 'update' },
    ]);
    watch.commit(first.sequence);
    expect(watch.checkpoint().changes).toHaveLength(1);
    const last = watch.checkpoint();
    watch.commit(last.sequence);
    expect(watch.checkpoint()).toMatchObject({ changes: [], unknown: false });
    receive!(new Error('overflow'), []);
    expect(watch.checkpoint().unknown).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ reconcile: true }));
    await watch.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('bounds event buffering and observes a Git directory outside a subproject', async () => {
    const root = resolve('virtual-repo'),
      git = resolve('virtual-git');
    const callbacks: Parameters<WatchSubscribe>[1][] = [],
      changed = vi.fn();
    const watch = new CodeMapWatch(root, changed, (_, callback) => {
      callbacks.push(callback);
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    });
    await watch.start([git]);
    expect(callbacks).toHaveLength(2);
    callbacks[1]!(null, [{ path: join(git, 'index'), type: 'update' }]);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ reconcile: true }));
    callbacks[0]!(
      null,
      Array.from({ length: 5000 }, (_, index) => ({ path: join(root, `${index}.ts`), type: 'update' as const })),
    );
    expect(watch.checkpoint().changes).toHaveLength(500);
    expect(watch.checkpoint().unknown).toBe(true);
    await watch.close();
  });
});
