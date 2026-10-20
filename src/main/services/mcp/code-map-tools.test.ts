import { expect, it, vi } from 'vitest';
import { buildCodeMapTools } from './code-map-tools';

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
  );
  await expect(search.run({ ...call, args: { query: 'x', limit: 51 } })).rejects.toThrow('Invalid');
  await expect(search.run({ ...call, caller: { context: {}, projectError: 'Conflicting selectors' } })).rejects.toThrow(
    'Conflicting',
  );
});
