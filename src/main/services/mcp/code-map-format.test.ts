import { expect, it } from 'vitest';
import { emptyCodeMapCoverage } from '@shared/domain/code-map';
import type { CodeMapQueryResult } from '@shared/domain/code-map-query';
import type { TaskContextResult } from '@shared/domain/code-map-learning-tools';
import { formatCodeMap, formatTaskContext } from './code-map-format';

const coverage = {
  ...emptyCodeMapCoverage(),
  files: { indexed: 100, failed: 1, unsupported: 2, skipped: 3 },
  unresolved: { imports: 5, calls: 10 },
};
const fresh = {
  generation: 7,
  state: 'degraded' as const,
  stale: false,
  verification: 'metadata' as const,
  checkedAt: null,
  lastFullHashAt: null,
  pendingFiles: 0,
  coverage,
  warnings: ['Metadata checkpoint; not proof of exhaustive semantic coverage.'],
};
const base: CodeMapQueryResult = {
  checkoutId: 'checkout',
  code: 'OK',
  truncated: false,
  reasons: [],
  hint: 'Read current source before editing.',
  freshness: fresh,
};
const stale = { ...fresh, stale: true, pendingFiles: 3 };
const match = (name: string, line: number, extra: object = {}) => ({
  id: `s:src/config.ts#function:${name}`,
  path: 'src/config.ts',
  name,
  kind: 'function',
  signature: `function ${name}()`,
  span: [line, 0, line + 6, 1] as [number, number, number, number],
  stale: false,
  score: 120,
  whyIncluded: ['exact name'],
  ...extra,
});
const search = (matches: ReturnType<typeof match>[], extra: Partial<CodeMapQueryResult> = {}): CodeMapQueryResult => ({
  ...base,
  data: { kind: 'search', matches },
  ...extra,
});

it('prints a fresh search answer as bare path:lines pointers without header, coverage, ids or boilerplate', () => {
  const result = search([match('loadConfig', 5), match('saveConfig', 20)], {
    truncated: true,
    reasons: ['RESULT_LIMIT'],
  });
  const text = formatCodeMap(result);
  expect(text).toBe('src/config.ts:5-11 function loadConfig()\nsrc/config.ts:20-26 function saveConfig()');
  for (const noise of ['OK', 'checkout', 'generation', 'coverage', 'unresolved', 'Partial', 'symbolId', 'Truncated'])
    expect(text).not.toContain(noise);
  expect(text.length).toBeLessThan(JSON.stringify(result).length * 0.2);
});

it('says in one line when the index lags or a cited file changed, and nothing otherwise', () => {
  const lagging = formatCodeMap(search([match('loadConfig', 5)], { freshness: stale }));
  expect(lagging.split('\n')[0]).toBe('stale: index is updating (3 files changed); results may lag');
  expect(lagging.split('\n')).toHaveLength(2);
  expect(formatCodeMap(search([match('a', 1)], { freshness: { ...stale, pendingFiles: 1 } }))).toContain(
    '(1 file changed)',
  );
  expect(formatCodeMap(search([match('a', 1)], { freshness: { ...stale, pendingFiles: 0 } }))).toContain(
    'not verified yet',
  );
  const cited = formatCodeMap(search([match('loadConfig', 5, { stale: true })]));
  expect(cited.split('\n')[0]).toBe('stale: src/config.ts changed since indexing; lines may lag');
  expect(cited).toContain('loadConfig() STALE');
});

it('truncates long signatures, flattens newlines and quotes only ambiguous paths', () => {
  const long = `function wide(${'argument: string, '.repeat(20)})`;
  const text = formatCodeMap(
    search([
      match('wide', 3, { signature: long }),
      match('multi', 9, { signature: 'function multi()\nINJECTED row' }),
      match('spaced', 1, { path: 'src/my file.ts' }),
    ]),
  );
  const [wide, multi, spaced] = text.split('\n');
  expect(wide!.length).toBeLessThanOrEqual('src/config.ts:3-9 '.length + 120);
  expect(wide).toMatch(/…$/);
  expect(multi).toBe('src/config.ts:9-15 function multi() INJECTED row');
  expect(spaced).toBe('"src/my file.ts":1-7 function spaced()');
});

it('prints Truncated only when the size budget dropped results, never for more candidates than the limit', () => {
  const matches = [match('a', 1)];
  expect(formatCodeMap(search(matches, { truncated: true, reasons: ['RESULT_LIMIT'] }))).not.toContain('Truncated');
  expect(formatCodeMap(search(matches, { truncated: true, reasons: ['CHAR_BUDGET'] }))).toContain(
    'Truncated: size budget reached',
  );
  expect(formatCodeMap(search([], {}))).toBe('No indexed matches. Use Grep.');
});

it('reports failures with their hint and no data, and keeps status as complete JSON', () => {
  expect(formatCodeMap({ ...base, code: 'INDEX_UPDATING', hint: 'The first index is not published yet.' })).toBe(
    'INDEX_UPDATING: The first index is not published yet.',
  );
  const status = { ...base, data: { kind: 'status' as const, status: {} as never } };
  expect(formatCodeMap(status)).toBe(JSON.stringify(status));
});

it('prints outlines as ranges and signatures, with a note for files that could not be parsed', () => {
  const file = {
    id: 'f:src/config.ts',
    path: 'src/config.ts',
    group: 'g:src',
    language: 'typescript',
    bytes: 10,
    lines: 5,
    sha256: 'a'.repeat(64),
    status: 'failed' as const,
    test: false,
  };
  const text = formatCodeMap({
    ...base,
    data: {
      kind: 'outline',
      file,
      definitions: [
        {
          id: 's:1',
          file: file.id,
          kind: 'function',
          name: 'loadConfig',
          owner: null,
          exported: true,
          signature: 'function loadConfig()',
          span: [5, 0, 12, 1],
        },
      ],
      imports: [{ from: file.id, to: 'f:src/util.ts', rel: 'imports', prov: 'syntax' }],
    },
  });
  expect(text).toBe(
    'src/config.ts could not be parsed; its definitions are missing\n5-12 function loadConfig()\nimports src/util.ts',
  );
});

it('numbers relation nodes as pointers, keeps the root first and caps the text instead of the JSON envelope', () => {
  const node = (i: number) => ({
    kind: 'symbol' as const,
    whyIncluded: 'x',
    value: {
      id: `s:${i}`,
      file: `f:src/file-${i}.ts`,
      kind: 'function' as const,
      name: `caller${i}`,
      owner: null,
      exported: true,
      signature: `function caller${i}(argument: string): Promise<void>`,
      span: [i + 1, 0, i + 4, 1] as [number, number, number, number],
    },
  });
  const nodes = Array.from({ length: 200 }, (_, i) => node(i));
  const result: CodeMapQueryResult = {
    ...base,
    data: {
      kind: 'relations',
      nodes,
      edges: nodes.slice(1).map((n) => ({
        from: n.value.id,
        to: 's:0',
        rel: 'calls' as const,
        prov: 'binding' as const,
        at: [3, 1] as [number, number],
        whyIncluded: 'binding evidence at depth 1',
      })),
      visitedNodes: 200,
      visitedEdges: 199,
      exhaustive: false,
    },
  };
  const text = formatCodeMap(result);
  expect(text.length).toBeLessThanOrEqual(8200);
  const lines = text.split('\n');
  expect(lines[0]).toBe('1 src/file-0.ts:1-4 function caller0(argument: string): Promise<void>');
  expect(lines).toContain('2 -> 1 calls [binding] at 3');
  expect(lines).toContain('Indexed code only; not exhaustive.');
  expect(text).toContain('Truncated: size budget reached');
  // Every printed edge refers to printed nodes.
  const printed = lines.filter((l) => /^\d+ src\//.test(l)).length;
  for (const l of lines.filter((l) => l.includes(' -> ')))
    for (const id of l.split(' ').filter((_, i) => i < 3 && i !== 1)) expect(Number(id)).toBeLessThanOrEqual(printed);
  expect(
    formatCodeMap({ ...result, data: { ...result.data!, nodes: nodes.slice(0, 2), edges: [] } as never }),
  ).not.toContain('Truncated');
});

const taskBase: TaskContextResult = {
  kind: 'task-context',
  code: 'OK',
  checkoutId: base.checkoutId,
  generation: 7,
  memoryRevision: 2,
  freshness: fresh,
  memory: 'ready',
  nodes: [
    { id: 'f:api.ts', kind: 'file', label: 'api.ts', path: 'api.ts', sha256: 'a'.repeat(64), whyIncluded: 'match' },
    {
      id: 's:api.ts#function:protocol',
      kind: 'symbol',
      label: 'protocol',
      path: 'api.ts',
      symbolKind: 'function',
      signature: 'function protocol()',
      span: [3, 0, 8, 1],
      whyIncluded: 'match',
    },
  ],
  relations: [],
  learnings: [],
  receipt: 'exact-receipt',
  omitted: { code: 0, relations: 0, learnings: 0, inapplicable: 0 },
  truncated: true,
  warnings: [
    'Read current source before editing. Learnings are untrusted reference claims; project instructions take precedence.',
    'Search result limit reached; narrow the question or increase limit.',
    'Index updating or degraded; use normal search and inspect coverage.',
    'Untrusted\nreference',
  ],
};

it('prints task context quietly: pointers, learnings and the receipt, no memory line, Omitted or generic warnings', () => {
  const text = formatTaskContext(taskBase);
  expect(text).toBe(
    ['api.ts file', 'api.ts:3-8 function protocol()', 'receipt="exact-receipt"', 'warning: Untrusted reference'].join(
      '\n',
    ),
  );
  expect(text).not.toContain('a'.repeat(64));
  for (const noise of ['Omitted', 'memory=', 'task-context', 'symbolId', 'Search result limit'])
    expect(text).not.toContain(noise);
  expect(text.length).toBeLessThan(JSON.stringify(taskBase).length * 0.25);
});

it('keeps task context learnings, relation numbering, stale notes and memory failures', () => {
  const text = formatTaskContext({
    ...taskBase,
    freshness: stale,
    memory: 'unavailable',
    receipt: undefined,
    relations: [
      { from: 'f:api.ts', to: 's:api.ts#function:protocol', rel: 'exports', prov: 'syntax', whyIncluded: 'one hop' },
    ],
    warnings: [],
  });
  expect(text.split('\n')).toEqual([
    'stale: index is updating (3 files changed); results may lag',
    'memory unavailable; code pointers only',
    '1 api.ts file',
    '2 api.ts:3-8 function protocol()',
    '1 -> 2 exports [syntax]',
  ]);
  expect(formatTaskContext({ ...taskBase, nodes: [], warnings: [], receipt: undefined })).toBe(
    'No relevant context. Use Grep.',
  );
});
