import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { type DatabaseEngine, DatabaseResourceSchema, type AccessMode } from '@shared/domain/project-resources';
import type { GuardOutcome, ResolvedDatabase } from '@shared/rpc/contracts/connections-host';
import { DbService } from '../../src/connections-host/db/db-service';

/**
 * The bridge against real database servers. Each engine runs when its URL is set (e.g. `OXY_TEST_PG_URL=
 * postgres://postgres:pw@localhost:5432/bank`) and is skipped otherwise; SQLite always runs. Every database needs a
 * `users` table (id, email, password_hash or passwordHash) with at least 20 rows — see `docs/testing-databases.md`.
 */
const SERVERS: { engine: DatabaseEngine; env: string; table: string; column: string }[] = [
  { engine: 'postgresql', env: 'OXY_TEST_PG_URL', table: 'users', column: 'email' },
  { engine: 'mysql', env: 'OXY_TEST_MYSQL_URL', table: 'users', column: 'email' },
  { engine: 'mariadb', env: 'OXY_TEST_MARIADB_URL', table: 'users', column: 'email' },
  { engine: 'sqlserver', env: 'OXY_TEST_MSSQL_URL', table: 'users', column: 'email' },
  { engine: 'clickhouse', env: 'OXY_TEST_CLICKHOUSE_URL', table: 'events', column: 'kind' },
  { engine: 'oracle', env: 'OXY_TEST_ORACLE_URL', table: 'users', column: 'email' },
];

const service = new DbService();
afterAll(() => service.dispose());

let n = 0;
function resolved(
  engine: DatabaseEngine,
  connection: { url: string } | { file: string },
  mode: AccessMode = 'read-only',
  extra: Record<string, unknown> = {},
): ResolvedDatabase {
  const id = `db${++n}`;
  const resource = DatabaseResourceSchema.parse({
    id,
    name: `${engine}-test`,
    engine,
    connection: 'url' in connection ? { kind: 'url' } : { kind: 'file', path: connection.file },
    tls: { mode: 'prefer', trustServerCertificate: true },
    access: { mode, maxRows: 5, timeoutMs: 15_000 },
    ...extra,
  });
  return {
    key: `p/${id}`,
    resource,
    projectRoot: tmpdir(),
    secrets: 'url' in connection ? { url: connection.url } : {},
    fingerprint: `${id}-${mode}`,
  };
}

const text = (o: GuardOutcome) => (o.status === 'done' ? o.text : `${o.status}: ${o.message}`);

describe.each(SERVERS)('$engine', ({ engine, env, table, column }) => {
  const url = process.env[env];
  const run = url ? it : it.skip;
  const q = (sql: string) => (engine === 'oracle' ? sql : sql);

  run('tests the connection and reports the version', async () => {
    const r = await service.test(resolved(engine, { url: url! }));
    expect(r.error?.message).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toMatch(/\d/);
  });

  run('reports a wrong password without leaking it', async () => {
    const wrong = url!.replace(/:\/\/([^:]+):([^@]*)@/, '://$1:Wrong_Secret_42@');
    const r = await service.test(resolved(engine, { url: wrong }));
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth');
    expect(r.error?.message).not.toContain('Wrong_Secret_42');
  });

  run('lists the schema and describes a table', async () => {
    const db = resolved(engine, { url: url! });
    const overview = await service.schema(db);
    expect(overview.toLowerCase()).toContain(table);
    const detail = await service.schema({ ...db, table: engine === 'oracle' ? table.toUpperCase() : table });
    expect(detail.toLowerCase()).toContain(column);
  });

  run('reads with a row cap and masks secret columns', async () => {
    const sql =
      engine === 'sqlserver'
        ? `SELECT * FROM ${table} ORDER BY 1`
        : engine === 'clickhouse'
          ? `SELECT * FROM ${table} ORDER BY ts`
          : `SELECT * FROM ${table} ORDER BY 1`;
    const r = await service.query({ ...resolved(engine, { url: url! }), query: q(sql) });
    expect(r.status, text(r)).toBe('done');
    expect(text(r)).toMatch(/5 of (more than 5|[\d,]+) rows shown/);
    if (engine !== 'clickhouse') {
      expect(text(r)).toContain('***');
      expect(text(r)).not.toMatch(/\| h\d* \|/);
    }
  });

  run('binds parameters', async () => {
    const marker = {
      postgresql: '$1',
      mysql: '?',
      mariadb: '?',
      sqlserver: '@p1',
      clickhouse: '{p1:String}',
      oracle: ':1',
      sqlite: '?',
    }[engine as 'postgresql'];
    const r = await service.query({
      ...resolved(engine, { url: url! }),
      query: `SELECT ${marker} AS v${engine === 'oracle' ? ' FROM dual' : ''}`,
      params: ["it's; DROP TABLE x"],
    });
    expect(text(r)).toContain("it's; DROP TABLE x");
  });

  run('refuses writes in read-only mode and asks in confirm mode', async () => {
    const write =
      engine === 'clickhouse'
        ? `INSERT INTO ${table} (ts, user_id, kind, duration) VALUES (now(), 1, 'oxy', 1)`
        : `UPDATE ${table} SET ${column} = ${column} WHERE 1 = 0`;
    const rejected = await service.query({ ...resolved(engine, { url: url! }), query: write });
    expect(rejected.status).toBe('rejected');
    const db = resolved(engine, { url: url! }, 'confirm-writes');
    const asked = await service.query({ ...db, query: write });
    expect(asked.status).toBe('needs-approval');
    const done = await service.query({ ...db, query: write, approved: true });
    expect(done.status, text(done)).toBe('done');
  });

  // Defense in depth: even if a write got past the guard, a read runs in a read-only transaction the server enforces.
  const serverEnforced = ['postgresql', 'mysql', 'mariadb', 'oracle', 'clickhouse'].includes(engine);
  (url && serverEnforced ? it : it.skip)('the server refuses a write sent as a read', async () => {
    const { DriverPool } = await import('../../src/connections-host/db/pool');
    const pool = new DriverPool();
    try {
      const { driver } = await pool.get(resolved(engine, { url: url! }));
      if (driver.family !== 'sql') throw new Error('not SQL');
      const write =
        engine === 'clickhouse'
          ? `INSERT INTO ${table} (ts, user_id, kind, duration) VALUES (now(), 1, 'oxy', 1)`
          : `UPDATE ${table} SET ${column} = ${column} WHERE 1 = 1`;
      await expect(driver.query(write, [], { maxRows: 5, timeoutMs: 10_000, write: false })).rejects.toThrow(
        /read.?only|READONLY|ORA-01456|cannot execute/i,
      );
    } finally {
      await pool.dispose();
    }
  });

  run('rejects the rejection corpus before it reaches the server', async () => {
    const db = resolved(engine, { url: url! });
    for (const sql of [`SELECT 1; DROP TABLE ${table}`, `/* x */ DELETE FROM ${table}`, `DROP TABLE ${table}`])
      expect((await service.query({ ...db, query: sql })).status).toBe('rejected');
  });
});

describe('sqlite', () => {
  it('reads a file database read-only, masks, caps and refuses writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-sqlite-'));
    const file = join(dir, 'app.db');
    const setup = new DatabaseSync(file);
    setup.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT); CREATE INDEX users_email ON users(email);',
    );
    for (let i = 1; i <= 30; i++)
      setup.exec(`INSERT INTO users (email, password_hash) VALUES ('u${i}@x.com', 'h${i}')`);
    setup.close();
    const db = resolved('sqlite', { file });
    expect((await service.test(db)).serverVersion).toMatch(/^SQLite 3/);
    expect(await service.schema(db)).toContain('users');
    expect(await service.schema({ ...db, table: 'users' })).toContain('INDEX users_email');
    const r = await service.query({ ...db, query: 'SELECT * FROM users ORDER BY id' });
    expect(text(r)).toContain('5 of 30 rows shown');
    expect(text(r)).toContain('***');
    expect((await service.query({ ...db, query: 'DELETE FROM users' })).status).toBe('rejected');
    const rw = resolved('sqlite', { file }, 'read-write');
    const del = await service.query({ ...rw, query: 'DELETE FROM users WHERE id = ?', params: [1] });
    expect(text(del)).toContain('1 row');
    expect((await service.query({ ...rw, query: 'DELETE FROM users' })).status).toBe('needs-approval');
  });

  it('stops a query at the time limit without blocking the host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-sqlite-'));
    const file = join(dir, 'slow.db');
    new DatabaseSync(file).close();
    const db = resolved('sqlite', { file }, 'read-only', { access: { mode: 'read-only', timeoutMs: 1000 } });
    const started = Date.now();
    await expect(
      service.query({
        ...db,
        query: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
      }),
    ).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(text(await service.query({ ...db, query: 'SELECT 1 AS one' }))).toContain('| 1 |');
  });
});

describe('mongodb', () => {
  const url = process.env['OXY_TEST_MONGO_URL'];
  const run = url ? it : it.skip;
  run('runs allowed operations, masks fields and follows the modes', async () => {
    const db = resolved('mongodb', { url: url! });
    expect((await service.test(db)).serverVersion).toMatch(/^MongoDB \d/);
    expect(await service.schema(db)).toContain('users');
    const shape = await service.schema({ ...db, table: 'users' });
    expect(shape).toContain('email');
    expect(shape).not.toMatch(/passwordHash[^\n]*e\.g\. "h/);
    const find = await service.mongo({
      ...db,
      collection: 'users',
      operation: 'find',
      args: { filter: { balance: { $gte: 0 } } },
    });
    expect(text(find)).toMatch(/5 of [\d,]+ documents shown/);
    expect(text(find)).toContain('"passwordHash":"***"');
    expect(text(find)).toContain('"apiToken":"***"');
    const agg = await service.mongo({
      ...db,
      collection: 'users',
      operation: 'aggregate',
      args: { pipeline: [{ $group: { _id: null, n: { $sum: 1 } } }] },
    });
    expect(text(agg)).toContain('"n":');
    expect(
      (await service.mongo({ ...db, collection: 'users', operation: 'aggregate', args: { pipeline: [{ $out: 'x' }] } }))
        .status,
    ).toBe('rejected');
    expect(
      (await service.mongo({ ...db, collection: 'users', operation: 'deleteMany', args: { filter: {} } })).status,
    ).toBe('rejected');
    const rw = resolved('mongodb', { url: url! }, 'read-write');
    expect(
      (await service.mongo({ ...rw, collection: 'users', operation: 'deleteMany', args: { filter: {} } })).status,
    ).toBe('needs-approval');
    const upd = await service.mongo({
      ...rw,
      collection: 'users',
      operation: 'updateOne',
      args: { filter: { email: 'nobody@x.com' }, update: { $set: { a: 1 } } },
    });
    expect(text(upd)).toContain('matchedCount');
  });
});

describe('redis', () => {
  const url = process.env['OXY_TEST_REDIS_URL'];
  const run = url ? it : it.skip;
  run('runs the allowlist, masks secret fields and refuses the rest', async () => {
    const db = resolved('redis', { url: url! });
    expect((await service.test(db)).serverVersion).toMatch(/^(Redis|Valkey) \d/);
    expect(await service.schema(db)).toMatch(/session:\*/);
    expect(text(await service.redis({ ...db, command: 'GET', args: ['user:1:name'] }))).toContain('User 1');
    const hash = text(await service.redis({ ...db, command: 'HGETALL', args: ['session:1'] }));
    expect(hash).toContain('"token"');
    expect(hash).toContain('***');
    expect(hash).not.toContain('tok1');
    expect((await service.redis({ ...db, command: 'SET', args: ['x', '1'] })).status).toBe('rejected');
    expect((await service.redis({ ...db, command: 'FLUSHALL', args: [] })).status).toBe('rejected');
    expect((await service.redis({ ...db, command: 'KEYS', args: ['*'] })).status).toBe('rejected');
  });
});
