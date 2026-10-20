import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckoutIndexer, type InventorySnapshot } from './indexer';
import { CodeMapScheduler } from './scheduler';
import type { WatchSubscribe } from './watch';
import * as enumeration from './enumerate';

vi.mock('./enumerate', async (original) => {
  const actual = await original<typeof enumeration>();
  return { ...actual, enumerate: vi.fn(actual.enumerate) };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const git of [false, true])
  it(`updates only watched paths ${git ? 'with' : 'without'} Git and matches a full scan`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-paths-')));
    roots.push(root);
    if (git) await promisify(execFile)('git', ['--no-optional-locks', 'init'], { cwd: root, windowsHide: true });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, '.gitignore'), 'ignored/\n');
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 1;');
    const snapshots: InventorySnapshot[] = [];
    const files: string[] = [];
    const removed: string[] = [];
    let receive: Parameters<WatchSubscribe>[1] | undefined;
    const scheduler = new CodeMapScheduler();
    const indexer = new CheckoutIndexer({
      checkoutId: 'c',
      projectId: 'p',
      root,
      gitPath: 'git',
      excludedPaths: [],
      scheduler,
      subscribe: (_, callback) => {
        receive = callback;
        return Promise.resolve({ unsubscribe: () => Promise.resolve() });
      },
      hooks: {
        start: () => undefined,
        file: (path) => {
          files.push(path);
        },
        removed: (path) => {
          removed.push(path);
        },
        failed: () => undefined,
        complete: (snapshot) => {
          snapshots.push(snapshot);
        },
        error: (error) => {
          throw error;
        },
      },
    });
    try {
      await indexer.start();
      await vi.waitFor(() => expect(snapshots).toHaveLength(1));
      const calls = vi.mocked(enumeration.enumerate).mock.calls.length;
      files.length = 0;
      await writeFile(join(root, 'src/a.ts'), 'export const a = 2;');
      await writeFile(join(root, 'src/c.bin'), Buffer.from([0, 1, 2]));
      await mkdir(join(root, 'ignored'));
      await writeFile(join(root, 'ignored/x.ts'), 'x');
      await rm(join(root, 'src/b.ts'));
      receive!(
        null,
        ['src/a.ts', 'src/c.bin', 'ignored/x.ts', 'src/b.ts'].map((path) => ({
          path: join(root, path),
          type: 'update' as const,
        })),
      );
      await vi.waitFor(() => expect(snapshots).toHaveLength(2), { timeout: 5000 });
      expect(vi.mocked(enumeration.enumerate).mock.calls.at(-1)![0].paths).toEqual([
        'ignored/x.ts',
        'src/a.ts',
        'src/b.ts',
        'src/c.bin',
      ]);
      expect(vi.mocked(enumeration.enumerate).mock.calls).toHaveLength(calls + 1);
      expect(files).toEqual(['src/a.ts']);
      expect(removed).toEqual(['src/b.ts']);
      const full = await enumeration.enumerate({ root, gitPath: 'git' });
      const limited = snapshots[1]!;
      expect([...limited.files.keys()].sort()).toEqual(full.files.map((file) => file.path));
      expect(limited.skippedCount).toBe(full.skippedPaths.size);
      expect(limited.diagnostics.skipped).toEqual(full.diagnostics.skipped);
    } finally {
      await indexer.dispose();
      scheduler.dispose();
    }
  });
