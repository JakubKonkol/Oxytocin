import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageEngine } from './engine';
import { getMeta } from './store/db';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('UsageEngine', () => {
  it('opens the database, records the pricing version and refreshes prices into the cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'oxy-usage-'));
    const fetch = vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { get: () => '"e"' },
        json: () =>
          Promise.resolve({
            'claude-new': {
              litellm_provider: 'anthropic',
              mode: 'chat',
              input_cost_per_token: 1e-6,
              output_cost_per_token: 2e-6,
            },
          } as unknown),
      }),
    );
    const engine = await UsageEngine.create({
      dbPath: ':memory:',
      storageDir: dir,
      fetch,
      now: () => Date.parse('2030-01-01'),
    });
    expect(engine.schemaVersion).toBe(2);
    const snapshotVersion = engine.pricing.version;
    expect(getMeta(engine.db, 'pricing_version')).toBe(snapshotVersion);

    engine.setSettings({ pricingAutoUpdate: false });
    expect(await engine.maybeRefreshPricing()).toBe('skipped');
    expect(await engine.maybeRefreshPricing(true)).toBe('updated');
    expect(engine.pricing.lookup('claude-new')?.source).toBe('cache');
    expect(getMeta(engine.db, 'pricing_version')).not.toBe(snapshotVersion);
    expect(JSON.parse(await readFile(join(dir, 'pricing-cache.json'), 'utf8'))).toMatchObject({ etag: '"e"' });

    engine.setSettings({ pricingOverrides: { 'claude-new': { input: 3, output: 4 } } });
    expect(engine.pricing.lookup('claude-new')?.source).toBe('override');
    engine.close();
  });
});
