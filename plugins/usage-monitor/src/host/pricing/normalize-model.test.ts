import { describe, expect, it } from 'vitest';
import { canonicalModel, resolveModelKey } from './normalize-model';

const known = new Set(['claude-opus-5-5', 'claude-sonnet-4-5', 'gpt-5', 'gpt-5.3-codex', 'gemini-2.5-pro', 'o3']);
const resolve = (m: string) => resolveModelKey(m, (k) => known.has(k));

describe('model normalization (docs/plan/08-usage-monitor.md §10.3)', () => {
  it.each([
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['Claude-Opus-5-5', 'claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['gpt-5-2025-08-07', 'gpt-5'],
    ['gpt-5.3-codex', 'gpt-5.3-codex'],
    ['openai/gpt-5.3-codex', 'gpt-5.3-codex'],
    ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['gemini-2.5-pro-preview', 'gemini-2.5-pro'],
    ['gemini-2.5-pro-latest', 'gemini-2.5-pro'],
    ['claude-opus-5-5-thinking', 'claude-opus-5-5'],
  ])('%s → %s', (raw, key) => {
    expect(resolve(raw)).toBe(key);
  });

  it('reports unknown models', () => {
    expect(resolve('claude-mystery-9')).toBeUndefined();
    expect(resolve('<synthetic>')).toBeUndefined();
    expect(resolve('')).toBeUndefined();
    // A one-segment prefix is too generic to match.
    expect(resolve('o3x')).toBeUndefined();
  });

  it('canonicalizes names', () => {
    expect(canonicalModel('  Anthropic/Claude-Opus-5-5[1M] ')).toBe('claude-opus-5-5');
  });
});
