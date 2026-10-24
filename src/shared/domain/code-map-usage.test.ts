import { describe, expect, it } from 'vitest';
import {
  CODE_MAP_USAGE_MAX_RANGES,
  CodeMapUsageQuerySchema,
  CodeMapUsageResultSchema,
  CodeMapUsageTotalsSchema,
} from './code-map-usage';

const range = { key: 'sess', terminalId: 't1', from: 1, to: 2 };

describe('Code Map usage contract', () => {
  it('accepts ranges and rejects anything else', () => {
    expect(CodeMapUsageQuerySchema.parse({ ranges: [range] })).toEqual({ ranges: [range] });
    expect(CodeMapUsageQuerySchema.safeParse({ ranges: [{ ...range, query: 'secret' }] }).success).toBe(false);
    expect(CodeMapUsageQuerySchema.safeParse({ ranges: [{ ...range, terminalId: '' }] }).success).toBe(false);
    expect(CodeMapUsageQuerySchema.safeParse({ ranges: [{ ...range, from: Infinity }] }).success).toBe(false);
    expect(CodeMapUsageQuerySchema.safeParse({}).success).toBe(false);
    expect(CodeMapUsageQuerySchema.safeParse(undefined).success).toBe(false);
    expect(
      CodeMapUsageQuerySchema.safeParse({ ranges: Array.from({ length: CODE_MAP_USAGE_MAX_RANGES + 1 }, () => range) })
        .success,
    ).toBe(false);
  });

  it('describes totals as non-negative counts only', () => {
    const totals = { calls: 2, chars: 300, stale: 1, notOk: 0, errors: 0 };
    expect(CodeMapUsageResultSchema.parse({ sess: totals })).toEqual({ sess: totals });
    expect(CodeMapUsageTotalsSchema.safeParse({ ...totals, calls: -1 }).success).toBe(false);
    expect(CodeMapUsageTotalsSchema.safeParse({ ...totals, query: 'x' }).success).toBe(false);
  });
});
