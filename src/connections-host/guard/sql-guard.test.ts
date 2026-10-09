import { beforeAll, describe, expect, it } from 'vitest';
import type { SqlDialect } from '@shared/domain/project-resources';
import { DENIED } from './functions';
import { loadSqlParsers } from './parsers';
import { classifySql, decide, isCleanRead, type SqlParsers } from './sql-guard';

let parsers: SqlParsers;
beforeAll(async () => {
  parsers = await loadSqlParsers();
});

const classify = (dialect: SqlDialect, sql: string, allowUserFunctions = false) =>
  classifySql(dialect, sql, parsers, { allowUserFunctions });
const readOnly = (dialect: SqlDialect, sql: string, allowUserFunctions = false) =>
  decide('read-only', classify(dialect, sql, allowUserFunctions), 'db').action;

/** The rejection corpus of the SQL guard, per dialect where the syntax exists. */
const MUST_REJECT: Record<SqlDialect, string[]> = {
  postgresql: [
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    'SELECT * INTO backup FROM users',
    "SELECT nextval('seq')",
    'SELECT pg_terminate_backend(1)',
    'EXPLAIN ANALYZE DELETE FROM users',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT 1',
    'SELECT 1; DROP TABLE users',
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM (SELECT * FROM users FOR SHARE) x',
    'SELECT my_cleanup()',
    'SELECT public.my_cleanup()',
    '/* x */ DELETE FROM users',
    'DELETE FROM users -- comment',
    'SELECT pg_catalog.pg_sleep(10)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)",
    "SELECT query_to_xml('DELETE FROM t', true, true, '')",
    "SELECT set_config('search_path', 'x', false)",
    'SELECT pg_advisory_lock(1)',
    "COPY users TO '/tmp/x'",
    'CALL cleanup()',
    'DO $$ BEGIN DELETE FROM users; END $$',
    'SET search_path TO x',
    'BEGIN',
    'TRUNCATE users',
    'VACUUM users',
    'GRANT SELECT ON users TO bob',
    'CREATE TABLE t (a int)',
    'LOCK TABLE users',
    "SELECT 'unterminated",
    'SELEC 1',
    '',
  ],
  mysql: [
    "SELECT * FROM users INTO OUTFILE '/tmp/x'",
    "SELECT * INTO DUMPFILE '/tmp/x' FROM users",
    'SELECT id INTO @v FROM users LIMIT 1',
    'SELECT SLEEP(5)',
    "SELECT BENCHMARK(1000000, MD5('a'))",
    "SELECT LOAD_FILE('/etc/passwd')",
    'SELECT /*!50000 SLEEP(5) */ 1',
    "SELECT 1 /*! INTO OUTFILE '/tmp/x' */",
    'SELECT 1 /*! ; DELETE FROM users */',
    "SELECT GET_LOCK('x', 10)",
    'SELECT * FROM users FOR UPDATE',
    'SELECT * FROM users LOCK IN SHARE MODE',
    'SELECT 1; DROP TABLE users',
    'SELECT my_cleanup()',
    '/* x */ DELETE FROM users',
    '# comment\nDELETE FROM users',
    'EXPLAIN ANALYZE SELECT * FROM users',
    'CALL cleanup()',
    'SET @a = 1',
    'CREATE TABLE t (a int)',
    'TRUNCATE users',
  ],
  mariadb: [
    "SELECT * FROM users INTO OUTFILE '/tmp/x'",
    'SELECT SLEEP(5)',
    'SELECT * FROM users FOR UPDATE',
    'SELECT 1; DROP TABLE users',
    'SELECT my_cleanup()',
    '/* x */ DELETE FROM users',
    'SELECT /*M! SLEEP(5) */ 1',
  ],
  sqlserver: [
    'SELECT * INTO backup FROM users',
    "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')",
    "SELECT * FROM OPENQUERY(linked, 'SELECT 1')",
    "WAITFOR DELAY '00:00:05'",
    'EXEC sp_who',
    'EXECUTE dbo.cleanup',
    'SELECT 1; DROP TABLE users',
    'SELECT dbo.fn_cleanup(1)',
    '/* x */ DELETE FROM users',
    'SELECT * FROM users WITH (UPDLOCK)',
    'SELECT NEXT VALUE FOR dbo.seq',
    'TRUNCATE TABLE users',
    'UPDATE users SET a = 1',
  ],
  sqlite: [
    "ATTACH DATABASE 'x.db' AS x",
    "SELECT load_extension('x')",
    "SELECT writefile('/tmp/x', 'a')",
    'SELECT my_cleanup()',
    'SELECT 1; DROP TABLE users',
    'PRAGMA writable_schema = 1',
    'DELETE FROM users',
    'VACUUM',
  ],
  clickhouse: [
    "SELECT * FROM url('http://example.com/x.csv', CSV)",
    "SELECT * FROM file('/etc/passwd', 'LineAsString')",
    "SELECT * FROM remote('other:9000', db.t)",
    'SELECT sleep(3)',
    'INSERT INTO t VALUES (1)',
    'ALTER TABLE t DELETE WHERE 1',
    'OPTIMIZE TABLE t',
    'SYSTEM DROP DNS CACHE',
    'SELECT 1; DROP TABLE t',
    "SELECT * FROM t INTO OUTFILE 'x'",
  ],
  oracle: [
    'SELECT DBMS_LOCK.SLEEP(5) FROM dual',
    "SELECT UTL_HTTP.REQUEST('http://x') FROM dual",
    'SELECT * FROM users FOR UPDATE',
    'SELECT my_cleanup() FROM dual',
    'SELECT pkg.cleanup() FROM dual',
    'EXPLAIN PLAN FOR SELECT * FROM users',
    'BEGIN cleanup; END;',
    'DELETE FROM users',
    'SELECT 1 FROM dual; DROP TABLE users',
    "SELECT q'[unterminated FROM dual",
  ],
};

/** Ordinary reads agents write: they must pass, so the guard is not so strict that agents give up. */
const MUST_PASS: Record<SqlDialect, string[]> = {
  postgresql: [
    'SELECT * FROM users',
    'select id, name from public.users u join orders o on o.user_id = u.id where o.total > 10',
    "SELECT u.id, count(*) OVER (PARTITION BY u.country ORDER BY u.created_at) FROM users u WHERE u.email ILIKE '%@x.com'",
    "SELECT data->>'name', data #>> '{a,b}', jsonb_array_length(data->'items') FROM events",
    'SELECT * FROM users ORDER BY last_login DESC NULLS LAST LIMIT 20 OFFSET 40',
    "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') SELECT count(*) FROM recent",
    "SELECT date_trunc('day', created_at) AS d, sum(total) FROM orders GROUP BY 1 HAVING sum(total) > 0",
    'SELECT coalesce(a, 0), greatest(1, 2), nullif(b, 0), CAST(c AS numeric), c::text FROM t',
    "SELECT pg_size_pretty(pg_total_relation_size('users'))",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    'SELECT * FROM users WHERE id = $1',
    'EXPLAIN SELECT * FROM users',
    'EXPLAIN DELETE FROM users',
    'SHOW search_path',
    'VALUES (1, 2), (3, 4)',
    "SELECT string_agg(name, ', ' ORDER BY name) FROM users",
    'SELECT * FROM generate_series(1, 10) g',
    'SELECT "Weird Name" FROM "Mixed Case"',
    'SELECT $$not; a statement$$ AS s',
    'SELECT 1; ',
    'SELECT pg_catalog.now()',
  ],
  mysql: [
    'SELECT * FROM users',
    "SELECT `id`, `name` FROM `shop`.`users` WHERE `name` LIKE 'a%' LIMIT 10, 20",
    "SELECT JSON_EXTRACT(data, '$.name'), JSON_UNQUOTE(data->'$.a') FROM events",
    'SELECT u.id, COUNT(*) OVER (PARTITION BY u.country) FROM users u',
    "SELECT DATE_FORMAT(created_at, '%Y-%m') m, SUM(total) FROM orders GROUP BY m ORDER BY m",
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT * FROM users',
    'SELECT * FROM users WHERE id = ?',
    'SELECT "double quoted string" AS s',
    'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
    'SELECT /* a comment */ 1',
  ],
  mariadb: ['SELECT * FROM users LIMIT 5', 'SHOW DATABASES', "SELECT CONCAT(first, ' ', last) FROM users"],
  sqlserver: [
    "SELECT TOP 10 [Id], [Name] FROM [dbo].[Users] WHERE [Name] LIKE N'a%' ORDER BY [Id]",
    'SELECT COUNT(*) OVER (PARTITION BY a) FROM t',
    'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
    'SELECT name FROM sys.tables',
    'SELECT CAST(x AS nvarchar(10)), GETDATE(), ISNULL(a, 0), DATEADD(day, -1, SYSDATETIME()) FROM t',
    'SELECT * FROM users WHERE id = @p1',
    'SELECT * FROM users ORDER BY id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY',
  ],
  sqlite: [
    'SELECT * FROM users',
    "SELECT * FROM t WHERE x GLOB 'a*'",
    "SELECT json_extract(data, '$.a'), strftime('%Y', created) FROM t",
    'SELECT * FROM users WHERE id = ?',
    'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
  ],
  clickhouse: [
    'SELECT count() FROM events WHERE toDate(ts) = today()',
    'SELECT uniqExact(user_id), quantile(0.9)(duration) FROM events GROUP BY toStartOfHour(ts)',
    'SHOW TABLES',
    'DESCRIBE TABLE events',
    'SELECT * FROM events FORMAT JSON',
    'WITH 1 AS x SELECT x',
  ],
  oracle: [
    'SELECT * FROM users',
    "SELECT id, NVL(name, 'x'), TO_CHAR(created, 'YYYY') FROM app.users WHERE ROWNUM <= 10",
    'SELECT * FROM users FETCH FIRST 10 ROWS ONLY',
    'SELECT COUNT(*) OVER (PARTITION BY a) FROM t',
    'WITH c AS (SELECT 1 AS x FROM dual) SELECT * FROM c',
    'SELECT * FROM users WHERE id = :1',
  ],
};

describe.each(Object.keys(MUST_REJECT) as SqlDialect[])('%s guard', (dialect) => {
  it.each(MUST_REJECT[dialect])('rejects in read-only mode: %s', (sql) => {
    expect(readOnly(dialect, sql)).toBe('reject');
  });
  it.each(MUST_PASS[dialect])('lets through: %s', (sql) => {
    const c = classify(dialect, sql);
    expect(c.reasons, JSON.stringify(c)).toEqual([]);
    expect(isCleanRead(c)).toBe(true);
  });
});

describe('denied functions', () => {
  const cases = (Object.entries(DENIED) as [SqlDialect, Record<string, string>][]).flatMap(([dialect, list]) =>
    Object.keys(list).map((fn) => [dialect, fn] as const),
  );
  it.each(cases)('%s: %s() is refused in read-only mode', (dialect, fn) => {
    const from = dialect === 'oracle' ? ' FROM dual' : '';
    const call = fn.includes('.') ? fn : fn;
    expect(readOnly(dialect, `SELECT ${call}(1)${from}`, true)).toBe('reject');
  });
});

describe('write modes', () => {
  it('confirm-writes asks for writes, runs reads', () => {
    expect(decide('confirm-writes', classify('postgresql', 'UPDATE users SET a = 1 WHERE id = 2'), 'db').action).toBe(
      'ask',
    );
    expect(decide('confirm-writes', classify('postgresql', 'SELECT 1'), 'db').action).toBe('run-read');
    expect(decide('confirm-writes', classify('postgresql', 'SELEC 1'), 'db').action).toBe('reject');
  });

  it('read-write runs ordinary writes and asks for dangerous ones', () => {
    const rw = (dialect: SqlDialect, sql: string) => decide('read-write', classify(dialect, sql), 'db').action;
    expect(rw('postgresql', 'UPDATE users SET a = 1 WHERE id = 2')).toBe('run-write');
    expect(rw('postgresql', "INSERT INTO users (name) VALUES ('a') RETURNING id")).toBe('run-write');
    expect(rw('postgresql', 'UPDATE users SET a = 1')).toBe('ask');
    expect(rw('postgresql', 'DELETE FROM users')).toBe('ask');
    expect(rw('postgresql', 'DROP TABLE users')).toBe('ask');
    expect(rw('postgresql', 'TRUNCATE users')).toBe('ask');
    expect(rw('postgresql', 'ALTER TABLE users DROP COLUMN a')).toBe('ask');
    expect(rw('postgresql', 'ALTER TABLE users ADD COLUMN a int')).toBe('run-write');
    expect(rw('mysql', 'DELETE FROM users')).toBe('ask');
    expect(rw('mysql', 'DELETE FROM users WHERE id = 1')).toBe('run-write');
    expect(rw('sqlserver', 'DROP TABLE users')).toBe('ask');
    expect(rw('sqlite', 'UPDATE users SET a = 1')).toBe('ask');
    expect(rw('oracle', 'DELETE FROM users')).toBe('ask');
    expect(rw('clickhouse', 'TRUNCATE TABLE t')).toBe('ask');
    expect(rw('postgresql', 'SELECT pg_terminate_backend(1)')).toBe('ask');
  });

  it('reports kinds and tables', () => {
    expect(classify('postgresql', 'DELETE FROM app.users WHERE id = 1')).toMatchObject({
      kind: 'write',
      statement: 'DELETE',
      tables: ['app.users'],
    });
    expect(classify('postgresql', 'DROP TABLE users')).toMatchObject({ kind: 'ddl', tables: ['users'] });
    expect(classify('postgresql', 'GRANT SELECT ON users TO bob').kind).toBe('dcl');
    expect(classify('mysql', 'UPDATE shop.users SET a = 1 WHERE id = 1')).toMatchObject({
      kind: 'write',
      tables: ['shop.users'],
    });
    expect(classify('postgresql', 'WITH x AS (SELECT 1) SELECT * FROM x JOIN users ON true').tables).toEqual(['users']);
  });

  it('allowUserFunctions lets user functions through in read-only mode', () => {
    expect(readOnly('postgresql', 'SELECT my_report(1)', true)).toBe('run-read');
    expect(readOnly('sqlserver', 'SELECT dbo.fn_total(1)', true)).toBe('run-read');
    // Denied functions stay denied.
    expect(readOnly('postgresql', 'SELECT pg_sleep(1)', true)).toBe('reject');
  });

  it('explains refusals to the agent', () => {
    const d = decide('read-only', classify('postgresql', 'SELECT * FROM users FOR UPDATE'), 'bank-db');
    expect(d.message).toContain('read-only');
    expect(d.message).toContain('locks rows');
    expect(decide('read-only', classify('postgresql', 'SELECT 1; SELECT 2'), 'x').message).toContain(
      'one statement per call',
    );
  });
});
