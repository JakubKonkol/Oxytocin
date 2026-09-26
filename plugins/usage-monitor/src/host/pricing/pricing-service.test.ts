import { describe, expect, it, vi } from 'vitest';
import { PricingService, REFRESH_INTERVAL_MS, type PricingCache } from './pricing-service';
import type { PricingTable } from './types';

const snapshot: PricingTable = {
  version: 'snap',
  generatedAt: '2026-09-01T00:00:00.000Z',
  source: 'test',
  models: { 'claude-a': { provider: 'anthropic', input: 1e-6, output: 2e-6, cacheRead: 1e-7 } },
};
const litellm = {
  'claude-a': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
  'claude-b': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 5e-6, output_cost_per_token: 6e-6 },
};

function setup(cache: PricingCache | null = null) {
  let now = Date.parse('2026-09-26T00:00:00Z');
  let stored = cache;
  const fetch = vi.fn((_url: string, _init: { headers: Record<string, string> }) =>
    Promise.resolve({
      status: 200,
      headers: { get: (n: string) => (n === 'etag' ? '"v1"' : null) },
      json: () => Promise.resolve(litellm as unknown),
    }),
  );
  const service = new PricingService({
    snapshot,
    readCache: () => Promise.resolve(stored),
    writeCache: (c) => {
      stored = c;
      return Promise.resolve();
    },
    fetch,
    now: () => now,
    warn: vi.fn(),
  });
  return { service, fetch, advance: (ms: number) => (now += ms), stored: () => stored };
}

describe('PricingService', () => {
  it('uses the snapshot, then a newer downloaded table, with user overrides on top', async () => {
    const s = setup();
    await s.service.load();
    expect(s.service.lookup('claude-a-20260101')).toMatchObject({ key: 'claude-a', source: 'snapshot' });
    expect(s.service.lookup('claude-b')).toBeUndefined();

    const changed = vi.fn();
    s.service.onDidChange(changed);
    expect(await s.service.refresh()).toBe('updated');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(s.service.lookup('claude-b')).toMatchObject({ source: 'cache', price: { input: 5e-6 } });
    expect(s.stored()?.etag).toBe('"v1"');

    const before = s.service.version;
    s.service.setOverrides({
      'Claude-A': { input: 10, output: 20, cacheRead: 1 },
      'my-model': { input: 1, output: 2 },
    });
    expect(s.service.version).not.toBe(before);
    expect(s.service.lookup('claude-a')).toMatchObject({
      source: 'override',
      price: { provider: 'anthropic', input: 1e-5, output: 2e-5, cacheRead: 1e-6 },
    });
    expect(s.service.lookup('my-model')).toMatchObject({ source: 'override', price: { provider: 'openai' } });
    expect(s.service.list().map((m) => m.model)).toEqual(['claude-a', 'claude-b', 'my-model']);
    expect(s.service.list()[0]!.perMillion).toEqual({ input: 10, output: 20, cacheRead: 1 });
  });

  it('refreshes once a day with the ETag and keeps the table on errors', async () => {
    const s = setup();
    await s.service.load();
    expect(s.service.shouldRefresh()).toBe(true);
    await s.service.refresh();
    expect(s.service.shouldRefresh()).toBe(false);
    s.advance(REFRESH_INTERVAL_MS);
    expect(s.service.shouldRefresh()).toBe(true);

    s.fetch.mockResolvedValueOnce({ status: 304, headers: { get: () => null }, json: () => Promise.resolve({}) });
    expect(await s.service.refresh()).toBe('unchanged');
    expect(s.fetch.mock.calls.at(-1)![1].headers['if-none-match']).toBe('"v1"');
    expect(s.service.shouldRefresh()).toBe(false);

    s.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await s.service.refresh()).toBe('failed');
    expect(s.service.lookup('claude-b')?.source).toBe('cache');
  });

  it('ignores an older cache and invalid overrides', async () => {
    const s = setup({ table: { ...snapshot, version: 'old', generatedAt: '2026-01-01T00:00:00.000Z' }, fetchedAt: 0 });
    await s.service.load();
    expect(s.service.table.version).toBe('snap');
    s.service.setOverrides({ bad: { input: 'x' } });
    expect(s.service.version).toBe('snap');
  });
});
