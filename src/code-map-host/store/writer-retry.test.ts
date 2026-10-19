import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicWrite } from './writer';

const mock = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  mock.rename.mockImplementation(fs.rename);
  return { ...fs, rename: mock.rename };
});
let directory: string;
afterEach(async () => {
  vi.clearAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('retries transient Windows rename failures without exposing a truncated previous graph', async () => {
  directory = await mkdtemp(join(tmpdir(), 'oxy-map-rename-'));
  const target = join(directory, 'graph.json');
  await writeFile(target, 'previous');
  mock.rename
    .mockImplementationOnce(async () => {
      expect(await readFile(target, 'utf8')).toBe('previous');
      throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' });
    })
    .mockRejectedValueOnce(Object.assign(new Error('Busy'), { code: 'EBUSY' }));
  await atomicWrite(target, 'next');
  expect(mock.rename).toHaveBeenCalledTimes(3);
  expect(await readFile(target, 'utf8')).toBe('next');
});
