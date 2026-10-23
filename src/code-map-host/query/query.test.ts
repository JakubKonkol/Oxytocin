import { expect, it } from 'vitest';
import { CodeMapQuerySchema, CodeMapQueryResultSchema } from '@shared/domain/code-map-query';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { fileRecord } from '../extract/files';
import { CodeSearch } from './search';
import { CodeRelations } from './relations';
import { fileOutline } from './outline';
import { repoMap } from './repo-map';
import { boundResult } from './budget';

function fixture(): CodeMapGraph {
  const files = ['src/user_service.ts', 'src/login.ts', 'tests/user_service.test.ts', 'src/loginExtra.ts'].map(
    (path) => fileRecord(path, '').file,
  );
  return {
    format: 'oxytocin.code-map',
    schemaVersion: 1,
    generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
    files,
    groups: [],
    packages: [],
    coverage: emptyCodeMapCoverage(),
    unresolved: [],
    symbols: files.flatMap((file) =>
      ['createUser', 'find_user'].map((name) => ({
        id: `${file.id}:${name}`,
        file: file.id,
        kind: 'function' as const,
        name,
        signature: `function ${name}(account: Account)`,
        owner: null,
        exported: true,
        span: [1, 0, 1, 30] as [number, number, number, number],
      })),
    ),
    edges: [
      { from: files[1]!.id, to: files[0]!.id, rel: 'imports', prov: 'binding', at: [1, 0] },
      { from: files[2]!.id, to: files[0]!.id, rel: 'calls', prov: 'heuristic' },
    ],
  };
}
it('ranks labelled identifier/path/signature terms with file diversity and deterministic ties (recall@8 = 1)', () => {
  const graph = fixture(),
    search = new CodeSearch(graph);
  for (const query of ['createUser', 'create user', 'find_user', 'Account']) {
    const found = search.search(query, undefined, 8).matches;
    expect(new Set(found.slice(0, 4).map((m) => m.path))).toEqual(new Set(graph.files.map((f) => f.path)));
    expect(found[0]!.path.startsWith('src/')).toBe(true);
    expect(found).toEqual(new CodeSearch(graph).search(query, undefined, 8).matches);
  }
  expect(search.search('user service', 'src', 8).matches.every((m) => m.path.startsWith('src/'))).toBe(true);
  expect(search.search('src/login.ts', undefined, 1).matches[0]!.id).toBe('f:src/login.ts');
  expect(search.search('user', 'src/login', 8).matches).toEqual([]);
  expect(search.search('nothing', undefined, 8).matches).toEqual([]);
});
it('outlines only indexed paths and filters repo map at path boundaries', () => {
  const graph = fixture();
  expect(fileOutline(graph, '.env')).toBeNull();
  expect(fileOutline(graph, 'src/login.ts')?.imports).toHaveLength(1);
  expect(fileOutline(graph, 'src/login.ts')?.definitions).toHaveLength(2);
  const map = repoMap(graph, new Map(), 'src/login.ts');
  expect(map).toContain('src/login.ts');
  expect(map).not.toContain('loginExtra');
});
it('ranks configuration declarations ahead of directory-only matches in English and Polish', () => {
  const graph = fixture();
  const settings = fileRecord('src/domain/code-map.ts', '').file;
  graph.files.push(
    settings,
    ...Array.from({ length: 30 }, (_, i) => fileRecord(`docs/code-map/plan-${i}.md`, '').file),
  );
  graph.symbols.push({
    id: 's:settings',
    file: settings.id,
    name: 'CodeMapSettingsSchema',
    kind: 'variable',
    owner: null,
    exported: true,
    signature: 'const CodeMapSettingsSchema',
    span: [3, 0, 20, 1],
  });
  const search = new CodeSearch(graph);
  for (const query of ['code map configuration', 'Gdzie w aplikacji mamy konfigurację code map']) {
    expect(search.search(query, undefined, 6).matches[0]?.id).toBe('s:settings');
  }
  expect(search.search('CodeMapSettingsSchema', undefined, 8).matches.map((m) => m.id)).toEqual(['s:settings']);
  expect(search.search('docs/code-map/plan-0.md', undefined, 8).matches.map((m) => m.path)).toEqual([
    'docs/code-map/plan-0.md',
  ]);
});

it('keeps useful edges with their endpoints when a relation response is budgeted', () => {
  const graph = fixture();
  graph.files.push(...Array.from({ length: 20 }, (_, i) => fileRecord(`src/dependent-${i}.ts`, '').file));
  graph.edges.push(
    ...graph.files
      .slice(4)
      .map((f) => ({ from: f.id, to: graph.files[0]!.id, rel: 'imports' as const, prov: 'binding' as const })),
  );
  const request = CodeMapQuerySchema.parse({ kind: 'relations', path: graph.files[0]!.path, direction: 'incoming' });
  if (request.kind !== 'relations') throw new Error('wrong kind');
  const data = new CodeRelations(graph).query(request).data!;
  const bounded = boundResult(
    {
      checkoutId: 'test',
      code: 'OK',
      freshness: {
        generation: 1,
        state: 'ready',
        stale: false,
        verification: 'metadata',
        checkedAt: null,
        lastFullHashAt: null,
        pendingFiles: 0,
        coverage: graph.coverage,
        warnings: [],
      },
      data,
      truncated: false,
      reasons: [],
      hint: '',
    },
    2000,
  );
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2000);
  if (bounded.data?.kind !== 'relations') throw new Error('lost relations');
  expect(bounded.data.edges.length).toBeGreaterThan(0);
  const ids = new Set(bounded.data.nodes.map((n) => n.value.id));
  expect(bounded.data.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
});
it('returns explicit nodes, evidence and provenance-filtered bounded relations', () => {
  const relations = new CodeRelations(fixture());
  const request = CodeMapQuerySchema.parse({ kind: 'relations', path: 'src/user_service.ts', direction: 'incoming' });
  if (request.kind !== 'relations') throw new Error('wrong kind');
  expect(relations.query(request).data?.edges).toHaveLength(1);
  expect(relations.query({ ...request, includeHeuristic: true }).data?.edges).toHaveLength(2);
  expect(relations.query({ ...request, direction: 'outgoing' }).data?.edges).toEqual([]);
  expect(relations.query({ ...request, path: undefined, symbolId: 'unknown' }).data).toBeNull();
  const graph = fixture();
  graph.edges = Array.from({ length: 5100 }, (_, i) => ({
    from: graph.files[1]!.id,
    to: graph.files[0]!.id,
    rel: 'imports',
    prov: 'syntax',
    at: [i + 1, 0],
  }));
  const result = new CodeRelations(graph).query(request);
  expect(result.truncated).toBe(true);
  expect(result.data?.visitedEdges).toBe(5000);
  expect(result.data?.exhaustive).toBe(false);
});
it('validates limits, cross-field selectors, traversal and budgets including JSON escaping', () => {
  for (const input of [
    { kind: 'search', query: 'x'.repeat(2001) },
    { kind: 'search', query: 'x', limit: 51 },
    { kind: 'relations', path: 'a.ts', symbolId: 's' },
    { kind: 'relations', path: 'a.ts', depth: 4 },
    { kind: 'outline', path: '../.env' },
    { kind: 'outline', path: 'C:/secret' },
    { kind: 'status', maxChars: 1999 },
    { kind: 'status', maxChars: 24001 },
  ])
    expect(CodeMapQuerySchema.safeParse(input).success).toBe(false);
  const result = CodeMapQueryResultSchema.parse({
    checkoutId: 'test',
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
    data: { kind: 'repo-map', markdown: '"\\\n'.repeat(3000) },
    truncated: false,
    reasons: [],
    hint: '',
  });
  const bounded = boundResult(result, 2000);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(2000);
  expect(bounded.truncated).toBe(true);
  expect(bounded.reasons).toContain('CHAR_BUDGET');
});
it('selects the innermost symbol at a path and line, preferring one that starts there, instead of the file', () => {
  const graph = fixture();
  const file = graph.files[0]!;
  graph.symbols.push(
    { ...graph.symbols[0]!, id: 'outer', file: file.id, name: 'Outer', span: [10, 0, 40, 1] },
    { ...graph.symbols[0]!, id: 'inner', file: file.id, name: 'inner', span: [20, 2, 25, 3] },
  );
  graph.edges.push({ from: graph.files[1]!.id, to: 'inner', rel: 'calls', prov: 'binding', at: [3, 0] });
  const relations = new CodeRelations(graph);
  const ask = (line: number, path = file.path) => {
    const request = CodeMapQuerySchema.parse({ kind: 'relations', path, line, direction: 'incoming' });
    if (request.kind !== 'relations') throw new Error('wrong kind');
    return relations.query(request).data;
  };
  expect(ask(22)?.nodes[0]?.value.id).toBe('inner');
  expect(ask(20)?.nodes[0]?.value.id).toBe('inner');
  expect(ask(10)?.nodes[0]?.value.id).toBe('outer');
  expect(ask(30)?.nodes[0]?.value.id).toBe('outer');
  expect(ask(22)?.edges).toHaveLength(1);
  expect(ask(500)).toBeNull();
  expect(ask(22, graph.files[1]!.path)).toBeNull();
  expect(CodeMapQuerySchema.safeParse({ kind: 'relations', symbolId: 'inner', line: 20 }).success).toBe(false);
});
