import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutIndexer, type InventorySnapshot } from './indexer';
import { CodeMapScheduler } from './scheduler';
import type { WatchSubscribe } from './watch';

vi.mock('./watch', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  discoverGitWatchDirectories: () => Promise.resolve([]),
}));

let root: string;
let indexer: CheckoutIndexer;
let scheduler: CodeMapScheduler;
afterEach(async () => {
  await indexer?.dispose();
  scheduler?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

/** A started indexer over real files with a watcher the test drives by hand. */
async function start() {
  root = await mkdtemp(join(tmpdir(), 'oxy-freshness-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/b.ts'), 'export const b = 1;\n');
  scheduler = new CodeMapScheduler();
  let receive!: Parameters<WatchSubscribe>[1];
  const builds: { files: number; fullHash: boolean }[] = [];
  const completed: InventorySnapshot[] = [];
  indexer = new CheckoutIndexer({
    checkoutId: 'c',
    projectId: 'p',
    root,
    gitPath: 'git-is-not-installed-here',
    excludedPaths: [],
    scheduler,
    subscribe: (_, callback) => {
      receive = callback;
      return Promise.resolve({ unsubscribe: () => Promise.resolve() });
    },
    hooks: {
      start: (files) => builds.push({ files, fullHash: false }),
      file: () => true,
      removed: () => undefined,
      failed: () => undefined,
      complete: (snapshot) => {
        builds.at(-1)!.fullHash = snapshot.fullHash;
        completed.push(snapshot);
      },
      error: (error) => {
        throw error;
      },
    },
  });
  await indexer.start();
  await vi.waitFor(() => expect(completed).toHaveLength(1));
  return { builds, receive };
}

describe('freshness barrier decisions', () => {
  it('answers at once while the watcher is healthy and nothing is pending', async () => {
    const { builds } = await start();
    expect(builds).toHaveLength(1);
    for (let query = 0; query < 5; query++) expect(await indexer.prepare()).toBe('current');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(builds).toHaveLength(1);
  });

  it('waits only for the path-limited build of pending events', async () => {
    const { builds, receive } = await start();
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    receive(null, [{ path: join(root, 'src/a.ts'), type: 'update' }]);
    expect(await indexer.prepare()).toBe('catch-up');
    await indexer.catchUp();
    expect(builds).toHaveLength(2);
    // Two files exist; the build enumerated just the changed one.
    expect(builds[1]).toEqual({ files: 1, fullHash: false });
    expect(await indexer.prepare()).toBe('current');
  });

  it('notices an edit the watcher has not delivered yet by probing recently modified files', async () => {
    const { builds } = await start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(root, 'src/b.ts'), 'export const b = 22222;\n');
    expect(await indexer.prepare()).toBe('catch-up');
    await indexer.catchUp();
    expect(builds[1]).toEqual({ files: 1, fullHash: false });
    expect(await indexer.prepare()).toBe('current');
  });

  it('audits after an overflow or watcher error, and always for verified queries', async () => {
    const { builds, receive } = await start();
    receive(new Error('overflow'), []);
    expect(await indexer.prepare()).toBe('audit');
    await indexer.verify(false);
    expect(builds.at(-1)!.files).toBe(2);
    expect(await indexer.prepare()).toBe('current');
    await indexer.verify(true);
    expect(builds.at(-1)).toEqual({ files: 2, fullHash: true });
  });

  it('treats Git state changes as pending work', async () => {
    const { builds, receive } = await start();
    receive(null, [{ path: join(root, '.git/HEAD'), type: 'update' }]);
    expect(await indexer.prepare()).toBe('catch-up');
    await indexer.catchUp();
    expect(builds.at(-1)!.files).toBe(2);
    expect(await indexer.prepare()).toBe('current');
  });
});
