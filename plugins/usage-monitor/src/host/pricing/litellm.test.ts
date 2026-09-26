import { describe, expect, it } from 'vitest';
import { transformLitellm } from './litellm';

describe('LiteLLM transform', () => {
  it('keeps chat models of the three providers without routed duplicates', () => {
    const table = transformLitellm(
      {
        sample_spec: { input_cost_per_token: 1 },
        'claude-x': {
          litellm_provider: 'anthropic',
          mode: 'chat',
          input_cost_per_token: 3e-6,
          output_cost_per_token: 1.5e-5,
          cache_read_input_token_cost: 3e-7,
          cache_creation_input_token_cost: 3.75e-6,
          cache_creation_input_token_cost_above_1hr: 6e-6,
          input_cost_per_token_above_200k_tokens: 6e-6,
          provider_specific_entry: { fast: 2, us: 1.1 },
          search_context_cost_per_query: { search_context_size_medium: 0.01 },
          max_input_tokens: 1000000,
        },
        'bedrock/claude-x': {
          litellm_provider: 'bedrock',
          mode: 'chat',
          input_cost_per_token: 1,
          output_cost_per_token: 1,
        },
        'gpt-x': {
          litellm_provider: 'openai',
          mode: 'responses',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
          input_cost_per_token_priority: 2e-6,
          input_cost_per_token_flex: 5e-7,
        },
        'gemini-x': {
          litellm_provider: 'vertex_ai-language-models',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 1e-5,
        },
        'text-embedding-x': {
          litellm_provider: 'openai',
          mode: 'embedding',
          input_cost_per_token: 1e-7,
          output_cost_per_token: 0,
        },
        'free-x': { litellm_provider: 'openai', mode: 'chat' },
      },
      new Date('2026-09-26T00:00:00Z'),
    );
    expect(Object.keys(table.models)).toEqual(['claude-x', 'gemini-x', 'gpt-x']);
    expect(table.models['claude-x']).toEqual({
      provider: 'anthropic',
      input: 3e-6,
      output: 1.5e-5,
      cacheRead: 3e-7,
      cacheWrite5m: 3.75e-6,
      cacheWrite1h: 6e-6,
      fastMultiplier: 2,
      usMultiplier: 1.1,
      webSearchPerQuery: 0.01,
      maxInputTokens: 1000000,
      above200k: { input: 6e-6 },
    });
    expect(table.models['gpt-x']).toMatchObject({ priority: { input: 2e-6 }, flex: { input: 5e-7 } });
    expect(table.models['gemini-x']!.provider).toBe('google');
    expect(table.version).toMatch(/^2026-09-26-[0-9a-f]{8}$/);
  });
});
