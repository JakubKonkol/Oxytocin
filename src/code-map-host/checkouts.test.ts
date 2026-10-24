import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyCodeMapAssets } from '../../scripts/code-map-assets';
import { CodeMapCheckouts } from './checkouts';
import { normalizedSource } from './extract/files';
import { buildSearchData } from './extract/search-data';
import { extractTypeScript } from './extract/typescript';
import { ParserRuntime } from './parse/runtime';

let root: string;
let checkouts: CodeMapCheckouts;
afterEach(async () => {
  await checkouts?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
describe('Code Map checkout lifetimes', () => {
  it('reports persisted coverage and size when another instance owns the checkout', async () => {
    root = await mkdtemp(join(tmpdir(), 'oxy-map-reader-'));
    await writeFile(join(root, 'notes.md'), '# Notes\n');
    const runtime = {
      assets: resolve('resources/code-map'),
      parserEntry: '/unused',
      parser: { parse: () => Promise.reject(new Error('Unexpected parser call')), dispose: () => Promise.resolve() },
    };
    checkouts = new CodeMapCheckouts('Oxytocin writer', () => {}, runtime);
    const config = {
      checkoutId: 'checkout',
      projectId: 'project',
      root,
      mode: 'project',
      gitPath: 'git',
      ignoreInGit: false,
    };
    await checkouts.configure(config);
    await vi.waitFor(() => expect(checkouts.status('checkout').state).toBe('ready'));
    const reader = new CodeMapCheckouts('Oxytocin reader', () => {}, runtime);
    try {
      const status = await reader.configure(config);
      expect(status.readOnly).toBe(true);
      expect(status.counts.files).toBe(1);
      expect(status.bytes).toBeGreaterThan(0);
      expect(Object.values(status.languages)).toContainEqual({ level: 'Files', description: 'File metadata only.' });
    } finally {
      await reader.dispose();
    }
  });
  it('serializes repeated configuration without leaking ownership and rejects invalid RPC data', async () => {
    root = await mkdtemp(join(tmpdir(), 'oxy-map-checkout-'));
    const changed = vi.fn();
    checkouts = new CodeMapCheckouts('Oxytocin test', changed, {
      assets: resolve('resources/code-map'),
      parserEntry: '/unused',
      parser: { parse: () => Promise.reject(new Error('Unexpected parser call')), dispose: () => Promise.resolve() },
    });
    await expect(checkouts.configure({ checkoutId: 123 })).rejects.toThrow();
    const config = {
      checkoutId: 'checkout',
      projectId: 'project',
      root,
      mode: 'project',
      gitPath: 'git',
      ignoreInGit: false,
    };
    const statuses = await Promise.all([checkouts.configure(config), checkouts.configure(config)]);
    expect(statuses.map((status) => status.readOnly)).toEqual([false, false]);
    expect(await readFile(join(root, '.oxy/README.md'), 'utf8')).not.toContain('It is ignored by Git');
    expect(await readFile(join(root, '.oxy/.gitignore'), 'utf8')).toContain('/learnings/local/');
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
    await checkouts.remove('checkout');
    expect(() => checkouts.status('checkout')).toThrow('Unknown');
    await expect(checkouts.deleteData('checkout', root)).resolves.toMatchObject({ state: 'disabled' });
    await expect(readFile(join(root, '.oxy/code-map/graph.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(checkouts.deleteData('checkout', root)).resolves.toMatchObject({ state: 'disabled' });
  });
  describe('search over published generations', () => {
    let assets: string;
    let runtime: ParserRuntime;
    beforeAll(async () => {
      assets = await mkdtemp(join(tmpdir(), 'oxy-map-search-assets-'));
      await copyCodeMapAssets(assets);
      runtime = new ParserRuntime(assets);
    });
    afterAll(async () => {
      runtime?.dispose();
      if (assets) await rm(assets, { recursive: true, force: true });
    });
    it('ranks by body terms, reports confidence and answers each generation from its own index', async () => {
      root = await mkdtemp(join(tmpdir(), 'oxy-map-search-'));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src/handler.ts'), 'export function handle() { return bodyonlyalpha; }\n');
      await writeFile(join(root, 'src/other.ts'), 'export function other() { return 1; }\n');
      checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
        assets,
        parserEntry: '/unused',
        parser: {
          parse: async (path: string, source: string) => {
            const text = normalizedSource(source);
            const tree = await runtime.parse(text, 'typescript');
            try {
              const record = extractTypeScript(path, text, tree);
              record.search = buildSearchData(text, record.symbols);
              return record;
            } finally {
              tree.delete();
            }
          },
          dispose: () => Promise.resolve(),
        },
      });
      await checkouts.configure({
        checkoutId: 'checkout',
        projectId: 'project',
        root,
        mode: 'project',
        gitPath: 'git',
        ignoreInGit: false,
      });
      await vi.waitFor(() => expect(checkouts.status('checkout')).toMatchObject({ state: 'ready', pendingFiles: 0 }));
      const ask = async (id: string, query: string, freshness: 'allow-stale' | 'verified' = 'allow-stale') => {
        const result = await checkouts.query('checkout', id, { kind: 'search', query, limit: 5, freshness });
        if (result.data?.kind !== 'search') throw new Error(`Unexpected answer ${result.code}`);
        return { ...result.data, generation: result.freshness.generation };
      };
      const first = await ask('q1', 'bodyonlyalpha');
      expect(first.matches[0]).toMatchObject({ path: 'src/handler.ts', name: 'handle' });
      expect(first.coverage).toBe(1);
      expect(first.strong).toBe(false);
      expect((await ask('q2', 'handle')).strong).toBe(true);
      const empty = await ask('q3', 'nonexistentword');
      expect(empty).toMatchObject({ matches: [] });
      expect(empty.coverage).toBeUndefined();

      await writeFile(join(root, 'src/handler.ts'), 'export function handle() { return bodyonlybeta; }\n');
      await vi.waitFor(async () => {
        const next = await ask('q4', 'bodyonlybeta', 'verified');
        expect(next.generation).toBeGreaterThan(first.generation);
        expect(next.matches[0]?.path).toBe('src/handler.ts');
      });
      expect((await ask('q5', 'bodyonlyalpha')).matches).toEqual([]);
    });

    it('inlines verified source lines on request and drops them as soon as the file differs from the index', async () => {
      root = await mkdtemp(join(tmpdir(), 'oxy-map-excerpt-'));
      await mkdir(join(root, 'src'));
      const source = [
        '// header',
        'export function handle() {',
        '  const first = 1;',
        '  return bodyonlygamma(first);',
        '}',
        '',
      ].join('\r\n');
      await writeFile(join(root, 'src/handler.ts'), `﻿${source}`);
      checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
        assets,
        parserEntry: '/unused',
        parser: {
          parse: async (path: string, raw: string) => {
            const text = normalizedSource(raw);
            const tree = await runtime.parse(text, 'typescript');
            try {
              const record = extractTypeScript(path, text, tree);
              record.search = buildSearchData(text, record.symbols);
              return record;
            } finally {
              tree.delete();
            }
          },
          dispose: () => Promise.resolve(),
        },
      });
      await checkouts.configure({
        checkoutId: 'checkout',
        projectId: 'project',
        root,
        mode: 'project',
        gitPath: 'git',
        ignoreInGit: false,
      });
      await vi.waitFor(() => expect(checkouts.status('checkout')).toMatchObject({ state: 'ready', pendingFiles: 0 }));
      const ask = async (id: string, excerpts?: 'terms' | 'full') => {
        const result = await checkouts.query('checkout', id, {
          kind: 'search',
          query: 'bodyonlygamma',
          freshness: 'allow-stale',
          ...(excerpts ? { excerpts } : {}),
        });
        if (result.data?.kind !== 'search') throw new Error(`Unexpected answer ${result.code}`);
        return result.data.matches[0]!;
      };
      // Pointers only unless asked; the CRLF file with a BOM verifies against its normalized hash.
      expect(await ask('e1')).not.toHaveProperty('excerpt');
      const found = await ask('e2', 'terms');
      expect(found.excerpt?.segments.flatMap((s) => s.lines)).toEqual([
        'export function handle() {',
        '  const first = 1;',
        '  return bodyonlygamma(first);',
        '}',
      ]);
      expect(found.excerpt?.segments[0]?.start).toBe(2);
      expect((await ask('e3', 'full')).excerpt?.omitted).toBe(0);
      // The map keeps the old generation while updates are paused; the file on disk is already different.
      checkouts.pause('checkout');
      await writeFile(join(root, 'src/handler.ts'), source.replace('bodyonlygamma', 'bodyonlydelta'));
      const changed = await ask('e4', 'terms');
      expect(changed).toMatchObject({ path: 'src/handler.ts', name: 'handle' });
      expect(changed).not.toHaveProperty('excerpt');
    });
  });
});
