import { describe, expect, it } from 'vitest';
import { duration, level, shortModel, tokens, usd } from './format';

describe('usage formatting', () => {
  it('formats money, tokens and durations', () => {
    expect(usd(4.8234)).toBe('$4.82');
    expect(usd(0.004)).toBe('<$0.01');
    expect(usd(0)).toBe('$0.00');
    expect(usd(1.5, { approx: true })).toBe('≈$1.50');
    expect(usd(1.23456, { precise: true })).toBe('$1.2346');
    expect(usd(null)).toBe('?');
    expect(usd(2, { unknown: true })).toBe('$2.00 + ?');
    expect(tokens(1_240_000)).toBe('1.24M');
    expect(tokens(412_345)).toBe('412k');
    expect(tokens(1500)).toBe('1.5k');
    expect(tokens(950)).toBe('950');
    expect(duration(45_000)).toBe('45 s');
    expect(duration(18 * 60_000)).toBe('18 min');
    expect(duration(72 * 60_000)).toBe('1h 12m');
    expect(duration(5 * 24 * 60 * 60_000)).toBe('5d 0h');
  });

  it('maps limit ratios to colour levels and shortens Claude model names', () => {
    expect([0.5, 0.7, 0.89, 0.9, 1.2].map(level)).toEqual(['ok', 'warning', 'warning', 'danger', 'danger']);
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5');
    expect(shortModel('gpt-5')).toBe('gpt-5');
    expect(shortModel(null)).toBe('—');
  });
});
