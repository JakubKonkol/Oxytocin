import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  });
});
