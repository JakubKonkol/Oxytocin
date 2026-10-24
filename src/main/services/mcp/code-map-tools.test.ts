import { expect, it, vi } from 'vitest';
import { buildCodeMapTools } from './code-map-tools';
import { buildLearningTools } from './code-map-learning-tools';

it('offers five read-only bounded tools, validates inputs and refuses unresolved callers', async () => {
  const query = vi.fn().mockResolvedValue({ code: 'OK' });
  const tools = buildCodeMapTools({ query });
  expect(tools).toHaveLength(5);
  expect(tools.every((t) => t.definition.annotations?.readOnlyHint && t.defaultPolicy === 'allow')).toBe(true);
  const search = tools.find((t) => t.definition.name === 'oxy_find_code')!;
  const call = {
    args: { query: 'CreateUser' },
    caller: { context: { projectId: 'p' } },
    signal: new AbortController().signal,
    sessionId: 's',
  };
  await search.run(call);
  expect(query).toHaveBeenCalledWith(
    'p',
    expect.objectContaining({ kind: 'search', query: 'CreateUser', limit: 8, maxChars: 8000 }),
    call.signal,
    undefined,
  );
  await expect(search.run({ ...call, args: { query: 'x', limit: 51 } })).rejects.toThrow('Invalid');
  await expect(search.run({ ...call, caller: { context: {}, projectError: 'Conflicting selectors' } })).rejects.toThrow(
    'Conflicting',
  );
});

const size = (t: { definition: { name: string; description: string; inputSchema: unknown } }) =>
  JSON.stringify({
    name: t.definition.name,
    description: t.definition.description,
    inputSchema: t.definition.inputSchema,
  }).length;
it('advertises the four default tools within 3,000 characters and hides what agents rarely need', () => {
  const tools = buildCodeMapTools({ query: vi.fn() });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const defaults = ['oxy_find_code', 'oxy_file_outline', 'oxy_code_relations', 'oxy_repo_map'].map((n) =>
    byName.get(n)!,
  );
  expect(defaults.reduce((sum, t) => sum + size(t), 0)).toBeLessThanOrEqual(3000);
  const advertised = JSON.stringify(tools.map((t) => t.definition.inputSchema));
  for (const dropped of ['freshness', 'maxChars', 'includeHeuristic', 'format', 'symbolId', '"relations"', 'project'])
    expect(advertised).not.toContain(dropped);
  const relations = byName.get('oxy_code_relations')!.definition;
  expect(Object.keys((relations.inputSchema as unknown as { properties: object }).properties)).toEqual([
    'cwd',
    'path',
    'line',
    'direction',
    'depth',
  ]);
  expect(relations.description).toContain('path:line');
});
it('still accepts the parameters it no longer advertises and gives relations a larger envelope for the compact text', async () => {
  const query = vi.fn().mockResolvedValue({ code: 'OK' });
  const tools = buildCodeMapTools({ query });
  const call = (name: string, args: Record<string, unknown>) => ({
    ...{ args, caller: { context: { projectId: 'p' } }, signal: new AbortController().signal, sessionId: 's' },
    tool: tools.find((t) => t.definition.name === name)!,
  });
  const relations = call('oxy_code_relations', { path: 'src/a.ts', line: 12, direction: 'incoming' });
  await relations.tool.run(relations);
  expect(query).toHaveBeenLastCalledWith(
    'p',
    expect.objectContaining({ kind: 'relations', path: 'src/a.ts', line: 12, direction: 'incoming', maxChars: 24000 }),
    relations.signal,
    undefined,
  );
  const explicit = call('oxy_code_relations', {
    path: 'src/a.ts',
    maxChars: 3000,
    freshness: 'allow-stale',
    format: 'json',
  });
  await explicit.tool.run(explicit);
  expect(query).toHaveBeenLastCalledWith(
    'p',
    expect.objectContaining({ maxChars: 3000, freshness: 'allow-stale' }),
    explicit.signal,
    undefined,
  );
  const both = call('oxy_code_relations', { path: 'src/a.ts', symbolId: 's' });
  await expect(both.tool.run(both)).rejects.toThrow('Invalid Code Map arguments');
  const lineOnly = call('oxy_code_relations', { line: 3 });
  await expect(lineOnly.tool.run(lineOnly)).rejects.toThrow('Invalid Code Map arguments');
});
it('keeps the learning tools small too: oxy_task_context shows three parameters', () => {
  const tools = buildLearningTools({ learningTool: vi.fn() });
  const context = tools.find((t) => t.definition.name === 'oxy_task_context')!;
  expect(Object.keys((context.definition.inputSchema as unknown as { properties: object }).properties)).toEqual([
    'cwd',
    'question',
    'paths',
  ]);
  expect(size(context)).toBeLessThanOrEqual(600);
});
it('reports how each answer went (stale, not OK) to the Hub without the text', async () => {
  const freshness = { state: 'ready', stale: false, pendingFiles: 0 };
  const query = vi
    .fn()
    .mockResolvedValueOnce({ code: 'OK', freshness, data: { kind: 'repo-map', markdown: '# map' }, reasons: [] })
    .mockResolvedValueOnce({
      code: 'OK',
      freshness: { ...freshness, stale: true, pendingFiles: 1 },
      data: { kind: 'repo-map', markdown: '# map' },
      reasons: [],
    })
    .mockResolvedValueOnce({ code: 'INDEX_UPDATING', hint: 'Indexing.', freshness, reasons: [] });
  const tool = buildCodeMapTools({ query }).find((t) => t.definition.name === 'oxy_repo_map')!;
  const report = vi.fn();
  const call = {
    args: {},
    caller: { context: { projectId: 'p' } },
    signal: new AbortController().signal,
    sessionId: 's',
    report,
  };
  for (let i = 0; i < 3; i++) await tool.run(call);
  expect(report.mock.calls).toEqual([
    [{ stale: false, notOk: false }],
    [{ stale: true, notOk: false }],
    [{ stale: false, notOk: true }],
  ]);
});
