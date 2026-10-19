import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CheckoutIndexer, type InventorySnapshot } from '../../src/code-map-host/indexer';
import { CodeMapScheduler } from '../../src/code-map-host/scheduler';

let root: string;
let indexer: CheckoutIndexer;
let scheduler: CodeMapScheduler;
afterEach(async () => {
  await indexer?.dispose();
  scheduler?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 10_000) throw new Error('Code Map watcher did not settle');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it('indexes real create/edit/delete/rename/atomic-save events and stops after removal', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-map-watch-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'first');
  scheduler = new CodeMapScheduler();
  const observed = new Map<string, string>();
  const errors: unknown[] = [];
  let snapshot: InventorySnapshot | undefined;
  let generations = 0;
  indexer = new CheckoutIndexer({
    root,
    checkoutId: 'checkout',
    projectId: 'project',
    gitPath: 'git',
    excludedPaths: [],
    scheduler,
    hooks: {
      start: () => undefined,
      file: (path, _, source) => {
        observed.set(path, source);
      },
      removed: (path) => {
        observed.delete(path);
      },
      failed: () => undefined,
      complete: (next) => {
        snapshot = next;
        generations++;
      },
      error: (error) => errors.push(error),
    },
  });
  await indexer.start();
  await until(() => observed.get('src/a.ts') === 'first');
  await writeFile(join(root, 'src/a.ts'), 'second');
  await until(() => observed.get('src/a.ts') === 'second');
  await writeFile(join(root, 'src/b.ts'), 'created');
  await until(() => observed.has('src/b.ts'));
  await rename(join(root, 'src/b.ts'), join(root, 'src/c.ts'));
  await until(() => observed.has('src/c.ts') && !observed.has('src/b.ts'));
  await writeFile(join(root, 'src/temporary'), 'atomic');
  await rename(join(root, 'src/temporary'), join(root, 'src/c.ts'));
  await until(() => observed.get('src/c.ts') === 'atomic');
  await rm(join(root, 'src/a.ts'));
  await until(() => !observed.has('src/a.ts'));
  expect(snapshot?.files.has('src/c.ts')).toBe(true);
  expect(errors).toEqual([]);
  indexer.pause();
  await writeFile(join(root, 'src/c.ts'), 'paused');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(observed.get('src/c.ts')).toBe('atomic');
  indexer.resume();
  await until(() => observed.get('src/c.ts') === 'paused');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = generations;
  await mkdir(join(root, '.oxy'));
  await writeFile(join(root, '.oxy/ignored.ts'), 'generated');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(generations).toBe(before);
  await indexer.dispose();
  await writeFile(join(root, 'src/c.ts'), 'after disposal');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(observed.get('src/c.ts')).toBe('paused');
  expect(await readFile(join(root, 'src/c.ts'), 'utf8')).toBe('after disposal');
});
