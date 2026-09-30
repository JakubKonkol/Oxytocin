import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { connect, freePort } from './helpers/mcp';
import { userDataWithPlugins } from './helpers/plugins';
import { readFile } from 'node:fs/promises';
import { activeProjectId, waitForTerminal } from './helpers/terminal';

const ENGINES: [string, string][] = [
  ['postgresql', 'OXY_TEST_PG_URL'],
  ['mysql', 'OXY_TEST_MYSQL_URL'],
  ['mariadb', 'OXY_TEST_MARIADB_URL'],
  ['sqlserver', 'OXY_TEST_MSSQL_URL'],
  ['mongodb', 'OXY_TEST_MONGO_URL'],
  ['redis', 'OXY_TEST_REDIS_URL'],
  ['clickhouse', 'OXY_TEST_CLICKHOUSE_URL'],
  ['oracle', 'OXY_TEST_ORACLE_URL'],
];
/**
 * The database drivers as bundled into the built Connections Host, against real servers: each engine runs when its
 * `OXY_TEST_*_URL` is set (see docs/testing-databases.md); SQLite always runs.
 */
test('database engines connect and answer through the built Connections Host', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-eng-')), 'p');
  await mkdir(project);
  const db = new DatabaseSync(join(project, 'x.db'));
  db.exec('CREATE TABLE t (a)');
  db.close();
  const port = await freePort();
  const userData = await userDataWithPlugins([], { 'mcp.port': port });
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    const id = await activeProjectId(win);
    const results: Record<string, unknown> = {};
    const configured = ENGINES.filter(([, env]) => process.env[env]);
    for (const [engine, env] of [...configured, ['sqlite', '']] as [string, string][]) {
      const resource =
        engine === 'sqlite'
          ? { id: 'e', name: 'e', engine, connection: { kind: 'file', path: 'x.db' } }
          : {
              id: 'e',
              name: 'e',
              engine,
              connection: { kind: 'url' },
              tls: { mode: 'prefer', trustServerCertificate: true },
            };
      results[engine] = await win.evaluate(
        ([projectId, resource, url]) =>
          window.oxy.invoke('resources:test', { projectId, kind: 'database', resource, secrets: url ? { url } : {} }),
        [id, resource, process.env[env] ?? ''] as const,
      );
    }
    for (const [engine, r] of Object.entries(results))
      expect((r as { ok: boolean }).ok, `${engine}: ${JSON.stringify(r)}`).toBe(true);
    const databases = [...configured, ['sqlite', '']].map(([engine, env], i) => ({
      id: `d${i}`,
      name: engine,
      engine,
      connection: engine === 'sqlite' ? { kind: 'file', path: 'x.db' } : { kind: 'url' },
      tls: { mode: 'prefer', trustServerCertificate: true },
      access: { maxRows: 3 },
      _url: process.env[env!] ?? '',
    }));
    await win.evaluate(
      ([projectId, dbs]) =>
        window.oxy.invoke('resources:save', {
          projectId,
          resources: { databases: dbs.map(({ _url, ...d }) => d) },
          secrets: dbs.filter((d) => d._url).map((d) => ({ resourceId: d.id, key: 'url', value: d._url })),
        }),
      [id, databases] as const,
    );
    await expect.poll(async () => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    const client = await connect(port, token);
    const q: Record<string, [string, Record<string, unknown>]> = {
      postgresql: ['oxy_db_query', { query: 'SELECT * FROM users ORDER BY id' }],
      mysql: ['oxy_db_query', { query: 'SELECT * FROM users ORDER BY id' }],
      mariadb: ['oxy_db_query', { query: 'SELECT * FROM users ORDER BY id' }],
      sqlserver: ['oxy_db_query', { query: 'SELECT * FROM users ORDER BY id' }],
      clickhouse: ['oxy_db_query', { query: 'SELECT * FROM events ORDER BY ts' }],
      oracle: ['oxy_db_query', { query: 'SELECT * FROM users ORDER BY id' }],
      sqlite: ['oxy_db_query', { query: 'SELECT * FROM t' }],
      mongodb: ['oxy_mongo', { collection: 'users', operation: 'find', args: { filter: {} } }],
      redis: ['oxy_redis', { command: 'HGETALL', args: ['session:1'] }],
    };
    for (const [engine, [tool, args]] of Object.entries(q).filter(
      ([e]) => e === 'sqlite' || configured.some(([c]) => c === e),
    )) {
      const r = await client.call(tool, { project: 'p', database: engine, ...args });
      const out = r.result?.content?.map((c) => c.text).join('') ?? JSON.stringify(r);
      expect(r.result?.isError, out).toBeFalsy();
      const schema = await client.call('oxy_db_schema', { project: 'p', database: engine });
      expect(schema.result?.isError, JSON.stringify(schema)).toBeFalsy();
    }
    client.close();
  } finally {
    await app.close();
  }
});
