import type { CostMode, ModelPrice, UsageExtras, UsageTokens } from './types';

/** USD cost of one response (docs/plan/08-usage-monitor.md §10.4). */
export function computeCost(tokens: UsageTokens, p: ModelPrice, extras: UsageExtras = {}): number {
  const promptTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  const tier = p.above200k && promptTotal > 200_000 ? { ...p, ...p.above200k } : p;
  const rate =
    extras.serviceTier === 'priority' && p.priority
      ? { ...tier, ...p.priority }
      : extras.serviceTier === 'flex' && p.flex
        ? { ...tier, ...p.flex }
        : tier;
  let cost =
    tokens.input * rate.input +
    tokens.output * rate.output +
    tokens.cacheRead * (rate.cacheRead ?? rate.input) +
    tokens.cacheWrite5m * (rate.cacheWrite5m ?? rate.input) +
    tokens.cacheWrite1h * (rate.cacheWrite1h ?? rate.cacheWrite5m ?? rate.input);
  if (extras.speed === 'fast' && p.fastMultiplier) cost *= p.fastMultiplier;
  if (extras.inferenceGeo === 'us' && p.usMultiplier) cost *= p.usMultiplier;
  cost += (extras.webSearchRequests ?? 0) * (p.webSearchPerQuery ?? 0);
  return cost;
}

/**
 * Cost of an event for the configured mode: `auto` prefers a cost reported by the source, `calculate` always uses
 * the pricing table, `reported` only trusts the source (null when missing). Null also means "unknown model".
 */
export function resolveCost(
  mode: CostMode,
  input: { tokens: UsageTokens; extras?: UsageExtras; price: ModelPrice | undefined; reportedUsd: number | null },
): { costUsd: number | null; costSource: 'computed' | 'reported' } {
  const computed = input.price ? computeCost(input.tokens, input.price, input.extras) : null;
  if (mode === 'reported') return { costUsd: input.reportedUsd, costSource: 'reported' };
  if (mode === 'auto' && input.reportedUsd !== null) return { costUsd: input.reportedUsd, costSource: 'reported' };
  return { costUsd: computed, costSource: 'computed' };
}
