import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statMany } from './stat-many';

let a: string;
let b: string;
beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'oxy-stat-'));
  a = join(base, 'a');
  b = join(base, 'b');
  await mkdir(join(b, 'src'), { recursive: true });
  await mkdir(a);
  await writeFile(join(b, 'src', 'x.ts'), '');
});
afterAll(async () => {
  await rm(join(a, '..'), { recursive: true, force: true });
});

describe('statMany', () => {
  it('resolves relative paths against base dirs in order and reports directories', async () => {
    const result = await statMany([a, b], ['src/x.ts', 'src', 'missing.ts', join(b, 'src', 'x.ts')]);
    expect(result).toEqual([
      { path: 'src/x.ts', resolved: join(b, 'src', 'x.ts'), isFile: true },
      { path: 'src', resolved: join(b, 'src'), isFile: false },
      { path: 'missing.ts', resolved: null, isFile: false },
      { path: join(b, 'src', 'x.ts'), resolved: join(b, 'src', 'x.ts'), isFile: true },
    ]);
  });
});
