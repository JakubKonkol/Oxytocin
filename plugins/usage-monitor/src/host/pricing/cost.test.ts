import { describe, expect, it } from 'vitest';
import snapshot from './snapshot.json';
import { computeCost, resolveCost } from './cost';
import type { ModelPrice, PricingTable, UsageTokens } from './types';

const models = (snapshot as PricingTable).models;
const price = (model: string) => models[model]!;
const tokens = (t: Partial<UsageTokens>): UsageTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...t,
});

describe('computeCost (golden values, docs/plan/08-usage-monitor.md §18)', () => {
  it('claude-opus-5-5 per token type', () => {
    const p = price('claude-opus-5-5');
    expect(computeCost(tokens({ input: 1_000_000 }), p)).toBeCloseTo(4.0, 10);
    expect(computeCost(tokens({ cacheRead: 100_000 }), p)).toBeCloseTo(0.02, 10);
    expect(computeCost(tokens({ cacheWrite1h: 10_000 }), p)).toBeCloseTo(0.08, 10);
    expect(computeCost(tokens({ output: 50_000 }), p)).toBeCloseTo(1.0, 10);
    expect(computeCost(tokens({ cacheWrite5m: 10_000 }), p)).toBeCloseTo(0.05, 10);
    expect(
      computeCost(tokens({ input: 1_000_000, cacheRead: 100_000, cacheWrite1h: 10_000, output: 50_000 }), p),
    ).toBeCloseTo(5.1, 10);
  });

  it('switches to the >200k tier on the whole prompt for models that have one', () => {
    const p = price('claude-sonnet-4-5');
    expect(computeCost(tokens({ input: 100_000, output: 1_000 }), p)).toBeCloseTo(0.3 + 0.015, 10);
    // 150k input + 60k cache read = 210k prompt → every rate from the >200k tier.
    expect(computeCost(tokens({ input: 150_000, cacheRead: 60_000, output: 1_000 }), p)).toBeCloseTo(
      150_000 * 6e-6 + 60_000 * 6e-7 + 1_000 * 2.25e-5,
      10,
    );
  });

  it('applies fast mode, US inference, web search and service tiers', () => {
    expect(computeCost(tokens({ output: 50_000 }), price('claude-opus-5-5'), { speed: 'fast' })).toBeCloseTo(2.0, 10);
    expect(computeCost(tokens({ input: 1_000_000 }), price('claude-sonnet-5'), { inferenceGeo: 'us' })).toBeCloseTo(
      2.2,
      10,
    );
    expect(computeCost(tokens({}), price('claude-opus-5-5'), { webSearchRequests: 3 })).toBeCloseTo(0.03, 10);
    const gpt = price('gpt-5');
    expect(computeCost(tokens({ input: 1_000_000 }), gpt)).toBeCloseTo(1.25, 10);
    expect(computeCost(tokens({ input: 1_000_000 }), gpt, { serviceTier: 'priority' })).toBeCloseTo(2.5, 10);
    expect(computeCost(tokens({ input: 1_000_000 }), gpt, { serviceTier: 'flex' })).toBeCloseTo(0.625, 10);
  });

  it('falls back to the input rate for missing cache rates', () => {
    const p: ModelPrice = { provider: 'openai', input: 1e-6, output: 2e-6 };
    expect(computeCost(tokens({ cacheRead: 10, cacheWrite5m: 10, cacheWrite1h: 10 }), p)).toBeCloseTo(3e-5, 15);
    const q: ModelPrice = { ...p, cacheWrite5m: 5e-6 };
    expect(computeCost(tokens({ cacheWrite1h: 10 }), q)).toBeCloseTo(5e-5, 15);
  });
});

describe('resolveCost', () => {
  const t = tokens({ output: 50_000 });
  const p = price('claude-opus-5-5');
  it('auto prefers the reported cost, calculate ignores it, reported needs it', () => {
    expect(resolveCost('auto', { tokens: t, price: p, reportedUsd: 0.5 })).toEqual({
      costUsd: 0.5,
      costSource: 'reported',
    });
    expect(resolveCost('auto', { tokens: t, price: p, reportedUsd: null })).toEqual({
      costUsd: 1,
      costSource: 'computed',
    });
    expect(resolveCost('calculate', { tokens: t, price: p, reportedUsd: 0.5 })).toEqual({
      costUsd: 1,
      costSource: 'computed',
    });
    expect(resolveCost('reported', { tokens: t, price: p, reportedUsd: null })).toEqual({
      costUsd: null,
      costSource: 'reported',
    });
    expect(resolveCost('calculate', { tokens: t, price: undefined, reportedUsd: null }).costUsd).toBeNull();
  });
});
