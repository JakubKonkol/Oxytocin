import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeMapCheckouts } from './checkouts';

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
});
