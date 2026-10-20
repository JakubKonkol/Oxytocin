import { expect, it } from 'vitest';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { CodeMapSliceQuerySchema, CodeMapHostQueryResultSchema } from '@shared/domain/code-map-plugin';
import { fileRecord } from '../extract/files';
import { graphSlice } from './slice';
import { boundSliceResult } from './slice-budget';

function fixture(): CodeMapGraph {
  const files = ['src/a/one.ts', 'src/a/two.ts', 'src/b/api.ts'].map((path) => fileRecord(path, '').file);
  return {
    format: 'oxytocin.code-map',
    schemaVersion: 1,
    generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
    files,
    groups: [],
    symbols: [],
    packages: [],
    unresolved: [],
    coverage: emptyCodeMapCoverage(),
    edges: [
      { from: files[0]!.id, to: files[2]!.id, rel: 'imports', prov: 'binding' },
      { from: files[1]!.id, to: files[2]!.id, rel: 'imports', prov: 'binding' },
      { from: files[1]!.id, to: files[2]!.id, rel: 'references', prov: 'binding', typeOnly: true },
    ],
  };
}
it('aggregates base edges with exact scoped counts and deterministic group ordering', () => {
  const graph = fixture(),
    request = CodeMapSliceQuerySchema.parse({ kind: 'slice', view: 'overview', pathPrefix: 'src' });
  const result = graphSlice(graph, request);
  expect(result.data?.nodes.map((n) => [n.id, n.files])).toEqual([
    ['d:src/a', 2],
    ['d:src/b', 1],
  ]);
  expect(result.data?.edges.map((e) => [e.rel, e.count])).toEqual([
    ['imports', 2],
    ['references', 1],
  ]);
  expect(
    graphSlice({ ...graph, files: [...graph.files].reverse(), edges: [...graph.edges].reverse() }, request),
  ).toEqual(result);
  const limited = graphSlice(graph, { ...request, maxNodes: 1 });
  expect(limited.reasons).toContain('NODE_LIMIT');
  expect(limited.data?.edges).toEqual([]);
});
it('bounds cyclic neighborhoods, keeps membership separate and reports limits', () => {
  const graph = fixture(),
    root = graph.files[0]!;
  graph.symbols.push({
    id: 's:run',
    file: root.id,
    name: 'run',
    kind: 'function',
    owner: null,
    exported: true,
    signature: 'function run()',
    span: [1, 0, 1, 10],
  });
  graph.edges.push(
    { from: root.id, to: 's:run', rel: 'contains', prov: 'syntax' },
    { from: graph.files[2]!.id, to: root.id, rel: 'imports', prov: 'binding' },
  );
  const request = CodeMapSliceQuerySchema.parse({
    kind: 'slice',
    view: 'file',
    root: { path: root.path },
    maxEdges: 1,
  });
  const result = graphSlice(graph, request);
  expect(result.data?.nodes.some((node) => node.id === 's:run')).toBe(true);
  expect(result.reasons).toContain('EDGE_LIMIT');
  expect(result.data?.exhaustive).toBe(false);
  expect(graphSlice(graph, { ...request, root: { path: '.env' } }).data).toBeNull();
  for (const input of [
    { kind: 'slice', view: 'file' },
    { kind: 'slice', view: 'overview', maxNodes: 501 },
    { kind: 'slice', view: 'overview', maxEdges: 1001 },
  ])
    expect(CodeMapSliceQuerySchema.safeParse(input).success).toBe(false);
});
it('enforces 512 KiB including UTF-8 metadata and removes dangling edges', () => {
  const result = CodeMapHostQueryResultSchema.parse({
    checkoutId: 'p',
    code: 'OK',
    freshness: {
      generation: 1,
      state: 'ready',
      stale: false,
      verification: 'metadata',
      checkedAt: null,
      lastFullHashAt: null,
      pendingFiles: 0,
      coverage: emptyCodeMapCoverage(),
      warnings: [],
    },
    data: {
      kind: 'slice',
      view: 'overview',
      nodes: Array.from({ length: 500 }, (_, i) => ({
        id: `f:${i}`,
        kind: 'file',
        label: '😀'.repeat(2000),
        whyIncluded: 'fixture',
      })),
      edges: [],
      visitedNodes: 500,
      visitedEdges: 0,
      exhaustive: false,
    },
    truncated: false,
    reasons: [],
    hint: '',
  });
  const bounded = boundSliceResult(result);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(512 * 1024);
  expect(bounded.reasons).toContain('BYTE_BUDGET');
});
