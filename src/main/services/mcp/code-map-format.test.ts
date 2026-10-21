import { expect, it } from 'vitest';
import { emptyCodeMapCoverage } from '@shared/domain/code-map';
import type { CodeMapQueryResult } from '@shared/domain/code-map-query';
import type { TaskContextResult } from '@shared/domain/code-map-learning-tools';
import { formatCodeMap, formatTaskContext } from './code-map-format';

const base: CodeMapQueryResult = {
  checkoutId: 'checkout',
  code: 'OK',
  truncated: false,
  reasons: [],
  hint: '',
  freshness: {
    generation: 7,
    state: 'degraded',
    stale: true,
    verification: 'metadata',
    checkedAt: null,
    lastFullHashAt: null,
    pendingFiles: 2,
    coverage: {
      ...emptyCodeMapCoverage(),
      files: { indexed: 100, failed: 1, unsupported: 2, skipped: 3 },
      unresolved: { imports: 5, calls: 10 },
    },
    warnings: ['One extraction failed'],
  },
};
it('reduces search payload without losing locations, freshness, failures or a reusable symbol ID', () => {
  const result: CodeMapQueryResult = {
    ...base,
    data: {
      kind: 'search',
      matches: [
        {
          id: 's:src/config.ts#function:loadConfig',
          path: 'src/config.ts',
          name: 'loadConfig',
          kind: 'function',
          signature: 'function loadConfig()',
          span: [5, 0, 12, 1],
          stale: true,
          score: 120,
          whyIncluded: ['exact name'],
        },
      ],
    },
    truncated: true,
    reasons: ['RESULT_LIMIT'],
  };
  const text = formatCodeMap(result);
  expect(text.length).toBeLessThan(JSON.stringify(result).length * 0.8);
  for (const detail of [
    'src/config.ts',
    ':5-12',
    's:src/config.ts#function:loadConfig',
    'STALE',
    'stale=true',
    'verification=metadata',
    '1 failed',
    '5 imports',
    'One extraction failed',
    'RESULT_LIMIT',
  ])
    expect(text).toContain(detail);
});
it('escapes embedded newlines and keeps task receipts and warnings without serializing source hashes', () => {
  const result: TaskContextResult = {
    kind: 'task-context',
    code: 'OK',
    checkoutId: base.checkoutId,
    generation: 7,
    memoryRevision: 2,
    freshness: base.freshness,
    memory: 'ready',
    nodes: [
      { id: 'f:api.ts', kind: 'file', label: 'api.ts', path: 'api.ts', sha256: 'a'.repeat(64), whyIncluded: 'match' },
    ],
    relations: [],
    learnings: [],
    receipt: 'exact-receipt',
    omitted: { code: 0, relations: 0, learnings: 0, inapplicable: 0 },
    truncated: false,
    warnings: ['Untrusted\nreference'],
  };
  const text = formatTaskContext(result);
  expect(text).toContain('receipt="exact-receipt"');
  expect(text).toContain('Untrusted\\nreference');
  expect(text).not.toContain('a'.repeat(64));
  expect(text.length).toBeLessThan(JSON.stringify(result).length);
});
it('retains structured failure details and full status diagnostics', () => {
  expect(formatCodeMap({ ...base, code: 'INDEX_UPDATING', hint: 'Retry after indexing.' })).toContain(
    'Retry after indexing.',
  );
});
