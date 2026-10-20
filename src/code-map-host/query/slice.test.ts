import { expect, it } from 'vitest';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { CodeMapSliceQuerySchema, CodeMapHostQueryResultSchema } from '@shared/domain/code-map-plugin';
import { fileRecord } from '../extract/files';
import { graphSlice } from './slice';
import { boundSliceResult } from './slice-budget';
import { CodeRelations } from './relations';

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

it('projects symbol calls to file dependents, follows incoming hops and excludes membership and heuristics', () => {
  const graph = fixture(),
    [one, two, api] = graph.files;
  graph.symbols = [one!, two!, api!].map((file, i) => ({
    id: `s:${i}`,
    file: file.id,
    kind: 'function',
    name: 'run',
    owner: null,
    exported: true,
    signature: 'run()',
    span: [1, 0, 1, 5],
  }));
  graph.edges = [
    { from: 's:0', to: 's:2', rel: 'calls', prov: 'binding' },
    { from: 's:1', to: 's:0', rel: 'calls', prov: 'binding' },
    { from: 's:2', to: 's:1', rel: 'calls', prov: 'binding' },
    { from: two!.id, to: api!.id, rel: 'imports', prov: 'heuristic' },
    { from: one!.id, to: 's:0', rel: 'contains', prov: 'syntax' },
  ];
  const request = CodeMapSliceQuerySchema.parse({
    kind: 'slice',
    view: 'impact',
    paths: [api!.path],
    direction: 'outgoing',
  });
  const first = graphSlice(graph, request);
  expect(first.data?.nodes.map((n) => n.id)).toEqual([api!.id, one!.id]);
  expect(first.data?.edges).toEqual([expect.objectContaining({ from: one!.id, to: api!.id, rel: 'calls' })]);
  expect(graphSlice(graph, { ...request, depth: 2 }).data?.nodes).toHaveLength(3);
  expect(graphSlice(graph, { ...request, depth: 3 }).data?.edges).toHaveLength(3);
  expect(graphSlice(graph, { ...request, includeHeuristic: true }).data?.nodes).toHaveLength(3);
  expect(graphSlice(graph, { ...request, maxNodes: 1 }).reasons).toContain('NODE_LIMIT');
  expect(graphSlice(graph, { ...request, paths: [] }).data?.nodes).toEqual([]);
  expect(graphSlice(graph, { ...request, paths: ['deleted.ts'] }).data?.nodes).toEqual([]);
  expect(graphSlice(graph, { ...request, paths: undefined, root: { path: 'deleted.ts' } }).data).toBeNull();
  const symbol = graphSlice(graph, { ...request, paths: undefined, root: { symbolId: 's:2' } });
  expect(symbol.data?.nodes.map((n) => n.id)).toEqual(['s:2', 's:0']);
  const membership = graphSlice(graph, {
    ...request,
    paths: undefined,
    root: { symbolId: 's:0' },
    relations: ['calls', 'contains'],
  });
  expect(membership.data?.nodes.map((n) => n.id)).toEqual(['s:0', 's:1']);
  for (const input of [
    { ...request, paths: ['../escape.ts'] },
    { ...request, paths: Array(501).fill('a.ts') },
    { ...request, root: { path: 'a.ts' } },
    { ...request, view: 'overview' },
    { ...request, depth: 4 },
  ])
    expect(CodeMapSliceQuerySchema.safeParse(input).success).toBe(false);
});

it('caps visited file nodes and edges and returns no dangling edges in dense impact slices', () => {
  const graph = fixture();
  graph.files = Array.from({ length: 2100 }, (_, i) => fileRecord(`file${i}.ts`, '').file);
  graph.edges = graph.files
    .slice(1)
    .map((f) => ({ from: f.id, to: graph.files[0]!.id, rel: 'imports', prov: 'binding' }));
  const query = CodeMapSliceQuerySchema.parse({
    kind: 'slice',
    view: 'impact',
    paths: [graph.files[0]!.path],
    maxNodes: 500,
    maxEdges: 1,
  });
  const result = graphSlice(graph, query);
  expect(result.data?.visitedNodes).toBe(2000);
  expect(result.reasons).toEqual(expect.arrayContaining(['VISIT_LIMIT', 'NODE_LIMIT', 'EDGE_LIMIT']));
  const ids = new Set(result.data!.nodes.map((n) => n.id));
  expect(result.data!.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  graph.edges = Array.from({ length: 5100 }, () => ({
    from: graph.files[1]!.id,
    to: graph.files[0]!.id,
    rel: 'calls',
    prov: 'heuristic',
  }));
  const found = new CodeRelations(graph).dependents([graph.files[0]!.path], query);
  expect(found.data.visitedEdges).toBe(5000);
  expect(found.truncated).toBe(true);
  expect(found.data.edges).toEqual([]);
});
