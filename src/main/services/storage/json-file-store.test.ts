import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write';
import { JsonFileStore, readJsonFile, readJsonFileSync } from './json-file-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const Schema = z.object({ version: z.literal(2), items: z.array(z.string()) });

describe('writeFileAtomic', () => {
  it('writes content and leaves no temp files', async () => {
    const file = join(dir, 'nested', 'a.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}');
    expect(await readdir(join(dir, 'nested'))).toEqual(['a.json']);
  });
});

describe('readJsonFile', () => {
  it('parses JSONC with comments and trailing commas', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{\n // comment\n "a": 1,\n}');
    expect(readJsonFileSync(file, { jsonc: true })).toEqual({ value: { a: 1 }, status: 'ok' });
  });

  it('moves corrupt files aside and restores from .bak', async () => {
    const file = join(dir, 'projects.json');
    await writeFile(file, '{ nope');
    await writeFile(`${file}.bak`, '{"ok":true}');
    const result = await readJsonFile(file);
    expect(result.status).toBe('restored-from-backup');
    expect(result.value).toEqual({ ok: true });
    expect((await readdir(dir)).some((f) => f.startsWith('projects.json.corrupt-'))).toBe(true);
  });

  it('reports missing files', async () => {
    expect(await readJsonFile(join(dir, 'none.json'))).toEqual({ value: undefined, status: 'missing' });
  });
});

describe('JsonFileStore', () => {
  const make = (file: string) =>
    new JsonFileStore({
      path: file,
      schema: Schema,
      defaults: () => ({ version: 2 as const, items: [] }),
      migrate: (raw) => {
        const r = raw as { version?: number; list?: string[] };
        return r.version === 1 ? { version: 2, items: r.list ?? [] } : raw;
      },
      debounceMs: 10,
      backup: true,
    });

  it('migrates older versions', async () => {
    const file = join(dir, 's.json');
    await writeFile(file, JSON.stringify({ version: 1, list: ['a'] }));
    const store = make(file);
    expect(await store.load()).toEqual({ version: 2, items: ['a'] });
  });

  it('falls back to defaults for invalid content', async () => {
    const file = join(dir, 's.json');
    await writeFile(file, JSON.stringify({ version: 2, items: 'x' }));
    const store = make(file);
    expect(await store.load()).toEqual({ version: 2, items: [] });
    expect(store.loadStatus).toBe('invalid');
  });

  it('persists on flush and writes a backup', async () => {
    const file = join(dir, 's.json');
    const store = make(file);
    store.set({ version: 2, items: ['x'] });
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, items: ['x'] });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual({ version: 2, items: ['x'] });
  });
});
