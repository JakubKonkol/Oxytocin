import { describe, expect, it, vi } from 'vitest';
import { DatabaseResourceSchema, emptyResources } from '@shared/domain/project-resources';
import type { GuardOutcome } from '@shared/rpc/contracts/connections-host';
import type { ResolvedCaller } from './caller-context';
import { buildResourceTools, type ResourceToolsDeps } from './resource-tools';

const project = { id: 'p1', name: 'bank', rootPath: '/p/bank' };
const resource = DatabaseResourceSchema.parse({
  id: 'd1',
  name: 'bank-db',
  engine: 'postgresql',
  connection: { kind: 'fields', host: 'localhost', options: {} },
  access: { mode: 'confirm-writes' },
});
const caller: ResolvedCaller = { context: { projectId: 'p1', terminalId: 't1' }, label: 'claude · bank' };

function setup(outcomes: GuardOutcome[], answer: boolean | null) {
  const host = vi.fn(() => Promise.resolve(outcomes.shift()!));
  const confirm = vi.fn(() => Promise.resolve(answer));
  const deps: ResourceToolsDeps = {
    resources: {
      accessible: () => [{ kind: 'database', project, own: true, resource }],
      find: () => ({ kind: 'database', project, own: true, resource }) as never,
      links: () => [],
      get: () => emptyResources(),
      resolveDatabase: () => ({ key: 'p1/d1', resource, projectRoot: '/p/bank', secrets: {}, fingerprint: 'f' }),
      resolveApi: () => {
        throw new Error('no');
      },
    },
    host: host as never,
    projects: () => [project],
    baseUrl: () => Promise.resolve('http://x'),
    confirm,
  };
  const tools = new Map(buildResourceTools(deps).map((t) => [t.definition.name, t]));
  return { tools, host, confirm };
}

const classification = {
  kind: 'write' as const,
  statement: 'UPDATE',
  tables: ['users'],
  reasons: ['UPDATE is not a read'],
  dangerous: [],
};
const call = (tools: ReturnType<typeof setup>['tools'], name: string, args: Record<string, unknown>) =>
  tools.get(name)!.run({ args, caller, sessionId: 's', signal: new AbortController().signal });

describe('resource tools', () => {
  it('asks the user and runs the approved statement', async () => {
    const { tools, host, confirm } = setup(
      [
        { status: 'needs-approval', message: 'needs approval', classification, preview: 'UPDATE users SET a = 1' },
        { status: 'done', text: 'UPDATE 1 — committed.', classification },
      ],
      true,
    );
    expect(await call(tools, 'oxy_db_query', { query: 'UPDATE users SET a = 1' })).toBe('UPDATE 1 — committed.');
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Allow UPDATE on bank-db?',
        code: 'UPDATE users SET a = 1',
        details: ['Kind: write · users', 'Why: UPDATE is not a read'],
      }),
    );
    expect(host.mock.calls.map((c) => (c as unknown[])[1] as { approved: boolean }).map((p) => p.approved)).toEqual([
      false,
      true,
    ]);
  });

  it('reports denials, timeouts and refusals as errors', async () => {
    const ask = { status: 'needs-approval' as const, message: 'm', classification, preview: 'x' };
    await expect(call(setup([ask], false).tools, 'oxy_db_query', { query: 'x' })).rejects.toThrow(
      /The user denied this UPDATE/,
    );
    await expect(call(setup([ask], null).tools, 'oxy_db_query', { query: 'x' })).rejects.toThrow(/nobody answered/);
    await expect(
      call(setup([{ status: 'rejected', message: 'Refused: read-only', classification }], true).tools, 'oxy_db_query', {
        query: 'x',
      }),
    ).rejects.toThrow('Refused: read-only');
    await expect(call(setup([], true).tools, 'oxy_db_query', {})).rejects.toThrow(/Pass `query`/);
  });

  it('keeps the query in the call log detail and lists resources without secrets', async () => {
    const { tools } = setup([], true);
    expect(tools.get('oxy_db_query')!.logDetail({ database: 'bank-db', query: 'SELECT 1' })).toBe('bank-db: SELECT 1');
    expect(tools.get('oxy_api_request')!.logDetail({ method: 'post', path: '/x' })).toBe('post /x');
    const listed = await call(tools, 'oxy_project_resources', {});
    expect(listed).toContain('"name": "bank-db"');
    expect(listed).toContain('reads; writes ask the user');
  });
});
