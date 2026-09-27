import { createHash } from 'node:crypto';
import type { ModelPrice, PricingTable } from './types';

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PROVIDERS: Record<string, ModelPrice['provider']> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  'vertex_ai-language-models': 'google',
};

type Raw = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function compact<T extends Record<string, unknown>>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** One LiteLLM entry → compact per-token rates, or null when not usable. */
export function toModelPrice(raw: Raw): ModelPrice | null {
  const provider = PROVIDERS[String(raw['litellm_provider'])];
  if (!provider || (raw['mode'] !== 'chat' && raw['mode'] !== 'responses')) return null;
  const input = num(raw['input_cost_per_token']);
  const output = num(raw['output_cost_per_token']);
  if (input === undefined || output === undefined) return null;
  const specific = (raw['provider_specific_entry'] ?? {}) as Raw;
  const search = (raw['search_context_cost_per_query'] ?? {}) as Raw;
  const price: ModelPrice = {
    provider,
    input,
    output,
    ...compact({
      cacheRead: num(raw['cache_read_input_token_cost']),
      cacheWrite5m: num(raw['cache_creation_input_token_cost']),
      cacheWrite1h: num(raw['cache_creation_input_token_cost_above_1hr']),
      fastMultiplier: num(specific['fast']),
      usMultiplier: num(specific['us']),
      webSearchPerQuery: num(search['search_context_size_medium']),
      maxInputTokens: num(raw['max_input_tokens']),
    }),
  };
  const above200k = compact({
    input: num(raw['input_cost_per_token_above_200k_tokens']),
    output: num(raw['output_cost_per_token_above_200k_tokens']),
    cacheRead: num(raw['cache_read_input_token_cost_above_200k_tokens']),
    cacheWrite5m: num(raw['cache_creation_input_token_cost_above_200k_tokens']),
    cacheWrite1h: num(raw['cache_creation_input_token_cost_above_1hr_above_200k_tokens']),
  });
  const priority = compact({
    input: num(raw['input_cost_per_token_priority']),
    output: num(raw['output_cost_per_token_priority']),
    cacheRead: num(raw['cache_read_input_token_cost_priority']),
  });
  const flex = compact({
    input: num(raw['input_cost_per_token_flex']),
    output: num(raw['output_cost_per_token_flex']),
    cacheRead: num(raw['cache_read_input_token_cost_flex']),
  });
  if (above200k) price.above200k = above200k;
  if (priority) price.priority = priority;
  if (flex) price.flex = flex;
  return price;
}

/** The whole LiteLLM file → pricing table (models without `/` only: no bedrock/azure duplicates). */
export function transformLitellm(data: Record<string, unknown>, now = new Date()): PricingTable {
  const models: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
    if (key.includes('/') || key === 'sample_spec' || typeof value !== 'object' || value === null) continue;
    const price = toModelPrice(value as Raw);
    if (price) models[key.toLowerCase()] = price;
  }
  const hash = createHash('sha256').update(JSON.stringify(models)).digest('hex').slice(0, 8);
  const day = now.toISOString().slice(0, 10);
  return { version: `${day}-${hash}`, generatedAt: now.toISOString(), source: LITELLM_URL, models };
}
