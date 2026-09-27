import { z } from 'zod';

const RatesSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});

/** Rates in USD per token. */
export const ModelPriceSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google']),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
  above200k: RatesSchema.optional(),
  priority: RatesSchema.optional(),
  flex: RatesSchema.optional(),
  fastMultiplier: z.number().positive().optional(),
  usMultiplier: z.number().positive().optional(),
  webSearchPerQuery: z.number().nonnegative().optional(),
  maxInputTokens: z.number().int().positive().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PricingTableSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  source: z.string(),
  models: z.record(z.string(), ModelPriceSchema),
});
export type PricingTable = z.infer<typeof PricingTableSchema>;

/** `usage.pricing.overrides`: USD per 1M tokens (friendlier to edit). */
export const PriceOverrideSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google']).optional(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;
export const PriceOverridesSchema = z.record(z.string(), PriceOverrideSchema);

export interface UsageTokens {
  /** Non-cached input (after normalizing the provider's semantics). */
  input: number;
  /** All billed output, including reasoning/thinking. */
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Informational: part of `output`. */
  reasoning: number;
}

export interface UsageExtras {
  webSearchRequests?: number;
  speed?: 'standard' | 'fast';
  serviceTier?: string;
  inferenceGeo?: string;
}

export type CostMode = 'auto' | 'calculate' | 'reported';
