import { afterEach, expect, it, vi } from 'vitest';
import { CheckoutIndexer, type InventorySnapshot } from './indexer';
import { CodeMapScheduler } from './scheduler';
import type { WatchSubscribe } from './watch';

const mocks = vi.hoisted(() => ({ enumerate: vi.fn() }));
vi.mock('./enumerate', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  enumerate: mocks.enumerate,
}));
vi.mock('./watch', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  discoverGitWatchDirectories: () => Promise.resolve([]),
}));
let indexer: CheckoutIndexer;
let scheduler: CodeMapScheduler;
afterEach(async () => {
  await indexer?.dispose();
  scheduler?.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('registers observation before scanning, reconciles by activity and audits hashes every 30 minutes', async () => {
  vi.useFakeTimers();
  const order: string[] = [],
    snapshots: InventorySnapshot[] = [];
  mocks.enumerate.mockImplementation(() => {
    order.push('scan');
    return Promise.resolve({
      root: '/virtual',
      files: [],
      diagnostics: { skipped: [], failed: [], unresolved: [], truncated: false },
      skippedCount: 0,
      git: false,
    });
  });
  scheduler = new CodeMapScheduler();
  let receive: Parameters<WatchSubscribe>[1] | undefined;
  indexer = new CheckoutIndexer({
    checkoutId: 'c',
    projectId: 'p',
    root: '/virtual',
    gitPath: 'git',
    excludedPaths: [],
    scheduler,
    subscribe: (_, callback) => {
      receive = callback;
      order.push('watch');
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    hooks: {
      start: () => undefined,
      file: () => undefined,
      removed: () => undefined,
      failed: () => undefined,
      complete: (snapshot) => {
        snapshots.push(snapshot);
      },
      error: (error) => {
        throw error;
      },
    },
  });
  await indexer.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(order).toEqual(['watch', 'scan']);
  expect(snapshots[0]!.fullHash).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshots).toHaveLength(1);
  scheduler.hints('p', []);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]!.fullHash).toBe(false);
  await vi.advanceTimersByTimeAsync(1_680_000);
  expect(snapshots.filter((snapshot) => snapshot.fullHash)).toHaveLength(2);
  indexer.pause();
  receive!(null, [{ path: '/virtual/dirty.ts', type: 'update' }]);
  expect(indexer.pendingFiles).toBe(1);
  const before = snapshots.length;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(snapshots).toHaveLength(before);
  indexer.resume();
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshots.at(-1)!.fullHash).toBe(true);
  expect(indexer.pendingFiles).toBe(0);
  await indexer.dispose();
  scheduler.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
