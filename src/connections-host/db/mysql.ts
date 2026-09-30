import type { Connection as CoreConnection, RowDataPacket } from 'mysql2';
import type { FieldPacket, Pool, PoolConnection, PoolOptions, ResultSetHeader } from 'mysql2/promise';
import type { ResultSet } from '../format';
import {
  stripTrailingSemicolons,
  type QueryOptions,
  type SchemaRequest,
  type SqlDriver,
  type TableInfo,
} from './driver';
import type { Target } from './target';
import { firstWorking, isNoTlsError, tlsOptions } from './tls';

const IDLE_MS = 5 * 60_000;
/** Rows counted past the cap before giving up on the exact total. */
const COUNT_LIMIT = 1_000_000;

/** MySQL and MariaDB (`mysql2`; the `mariadb` package is LGPL). */
export async function createMysql(t: Target, o: { root: string }): Promise<SqlDriver> {
  const mysql = await import('mysql2/promise');
  // Named exports of the CommonJS module differ between loaders (bundled, ESM, tests): take them from either shape.
  const core = (await import('mysql2')) as unknown as { Types?: unknown; default?: { Types?: unknown } };
  const Types = (core.Types ?? core.default?.Types ?? {}) as Record<number, string>;
  const typeName = (f: FieldPacket) =>
    (f.typeName ?? Types[f.columnType ?? f.type ?? -1] ?? String(f.columnType ?? f.type ?? '')).toLowerCase();
  const tls = await tlsOptions(t, o.root);
  const base: PoolOptions = {
    host: t.host,
    port: t.port ?? 3306,
    ...(t.user ? { user: t.user } : {}),
    ...(t.password !== undefined ? { password: t.password } : {}),
    ...(t.database ? { database: t.database } : {}),
    connectionLimit: 2,
    maxIdle: 0,
    idleTimeout: IDLE_MS,
    connectTimeout: 10_000,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    enableKeepAlive: true,
  };
  const ssl = tls
    ? { rejectUnauthorized: tls.rejectUnauthorized !== false, ...(typeof tls.ca === 'string' ? { ca: tls.ca } : {}) }
    : undefined;
  const variants: PoolOptions[] = !ssl
    ? [base]
    : t.tls.mode === 'prefer'
      ? [{ ...base, ssl }, base]
      : [{ ...base, ssl }];
  let pool: Pool | undefined;
  let ready: Promise<Pool> | undefined;
  let mariadb = t.engine === 'mariadb';

  const getPool = () => {
    ready ??= firstWorking(
      variants,
      async (config) => {
        const candidate = mysql.createPool(config);
        try {
          const conn = await candidate.getConnection();
          const [rows] = await conn.query<({ v: string } & RowDataPacket)[]>('SELECT VERSION() AS v');
          mariadb = /mariadb/i.test(rows[0]?.v ?? '') || t.engine === 'mariadb';
          conn.release();
          return candidate;
        } catch (e) {
          await candidate.end().catch(() => undefined);
          throw e;
        }
      },
      isNoTlsError,
    ).then(
      (p) => (pool = p),
      (e: unknown) => {
        ready = undefined;
        throw e;
      },
    );
    return ready;
  };

  const setStatementTimeout = async (conn: PoolConnection, ms: number) => {
    if (mariadb) await conn.query(`SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)}`);
    else await conn.query(`SET SESSION max_execution_time = ${Math.round(ms)}`);
  };

  const withConnection = async <R>(fn: (conn: PoolConnection) => Promise<R>): Promise<R> => {
    const conn = await (await getPool()).getConnection();
    let broken = false;
    try {
      return await fn(conn);
    } catch (e) {
      broken = /PROTOCOL_CONNECTION_LOST|ECONNRESET|timeout/i.test(String(e));
      throw e;
    } finally {
      if (broken) conn.destroy();
      else conn.release();
    }
  };

  /** Streams a read, keeping `maxRows + 1` rows and counting the rest. */
  const streamRead = (conn: PoolConnection, sql: string, params: unknown[], q: QueryOptions) =>
    new Promise<ResultSet>((resolve, reject) => {
      let fields: FieldPacket[] = [];
      const rows: unknown[][] = [];
      let count = 0;
      let gaveUp = false;
      // The callback connection streams rows (the promise API buffers the whole result).
      const core = conn.connection as unknown as CoreConnection;
      const query = core.query({ sql, values: params, rowsAsArray: true, timeout: q.timeoutMs + 2000 });
      query.on('fields', (f: FieldPacket[]) => (fields = f));
      query.on('result', (row: unknown) => {
        if (!Array.isArray(row)) return;
        count++;
        if (rows.length <= q.maxRows) rows.push(row as unknown[]);
        else if (count > q.maxRows + COUNT_LIMIT && !gaveUp) gaveUp = true;
      });
      query.on('error', reject);
      query.on('end', () => {
        try {
          resolve({
            columns: fields.map((f) => ({ name: f.name, type: typeName(f) })),
            rows,
            total: gaveUp ? null : count,
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });

  return {
    family: 'sql',
    async version() {
      return withConnection(async (conn) => {
        const [rows] = await conn.query<({ v: string } & RowDataPacket)[]>('SELECT VERSION() AS v');
        const v = rows[0]?.v ?? '';
        return /mariadb/i.test(v) ? `MariaDB ${v.replace(/-MariaDB.*$/i, '')}` : `MySQL ${v}`;
      });
    },

    async query(sql, params, q) {
      const text = stripTrailingSemicolons(sql);
      return withConnection(async (conn) => {
        await setStatementTimeout(conn, q.timeoutMs);
        await conn.query(q.write ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY');
        let done = false;
        try {
          let result: ResultSet;
          if (!q.write) result = await streamRead(conn, text, params, q);
          else {
            const [r, fields] = await conn.query({
              sql: text,
              values: params,
              rowsAsArray: true,
              timeout: q.timeoutMs + 2000,
            });
            if (Array.isArray(r)) {
              const f = fields ?? [];
              result = {
                columns: f.map((x) => ({ name: x.name, type: typeName(x) })),
                rows: r as unknown[][],
                total: r.length,
              };
            } else {
              const header = r as ResultSetHeader;
              result = {
                columns: [],
                rows: [],
                total: 0,
                affected: header.affectedRows,
                command: `${header.affectedRows} affected${header.insertId ? `, insert id ${header.insertId}` : ''}`,
              };
            }
          }
          await conn.query(q.write ? 'COMMIT' : 'ROLLBACK');
          done = true;
          return result;
        } finally {
          if (!done) await conn.query('ROLLBACK').catch(() => undefined);
          await conn
            .query('SET SESSION ' + (mariadb ? 'max_statement_time = 0' : 'max_execution_time = 0'))
            .catch(() => undefined);
        }
      });
    },

    async schema(r: SchemaRequest): Promise<TableInfo[]> {
      return withConnection(async (conn) => {
        await setStatementTimeout(conn, r.timeoutMs);
        type Row = RowDataPacket;
        const where: string[] = [];
        const values: unknown[] = [];
        if (r.schema) {
          where.push('TABLE_SCHEMA = ?');
          values.push(r.schema);
        } else if (t.database) {
          where.push('TABLE_SCHEMA = DATABASE()');
        } else where.push("TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')");
        if (r.table) {
          where.push('TABLE_NAME = ?');
          values.push(r.table);
        }
        const [tables] = await conn.query<Row[]>(
          `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS k, TABLE_ROWS AS r, TABLE_COMMENT AS c
             FROM information_schema.TABLES WHERE ${where.join(' AND ')} ORDER BY 1, 2 LIMIT 2000`,
          values,
        );
        const out: TableInfo[] = tables.map((x) => ({
          schema: String(x['s']),
          name: String(x['n']),
          type: String(x['k']).toLowerCase().replace('base table', 'table'),
          ...(x['r'] !== null && x['r'] !== undefined ? { rows: Number(x['r']) } : {}),
          ...(x['c'] ? { comment: String(x['c']) } : {}),
        }));
        if (!r.schema && !r.table) return out;
        const key = (s: unknown, n: unknown) => `${String(s)}.${String(n)}`;
        const byName = new Map(out.map((x) => [key(x.schema, x.name), x]));
        const [cols] = await conn.query<Row[]>(
          `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS nl,
                  COLUMN_DEFAULT AS d, COLUMN_KEY AS k
             FROM information_schema.COLUMNS WHERE ${where.join(' AND ')} ORDER BY 1, 2, ORDINAL_POSITION`,
          values,
        );
        for (const c of cols) {
          const tbl = byName.get(key(c['s'], c['n']));
          if (!tbl) continue;
          (tbl.columns ??= []).push({
            name: String(c['c']),
            type: String(c['t']),
            nullable: c['nl'] === 'YES',
            default: c['d'] === null || c['d'] === undefined ? null : String(c['d']),
          });
          if (c['k'] === 'PRI') (tbl.primaryKey ??= []).push(String(c['c']));
        }
        if (r.table) {
          const [fks] = await conn.query<Row[]>(
            `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, CONSTRAINT_NAME AS cn, COLUMN_NAME AS c,
                    REFERENCED_TABLE_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rn, REFERENCED_COLUMN_NAME AS rc
               FROM information_schema.KEY_COLUMN_USAGE
              WHERE ${where.join(' AND ')} AND REFERENCED_TABLE_NAME IS NOT NULL
              ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
            values,
          );
          const grouped = new Map<string, { tbl: TableInfo; columns: string[]; ref: string; refCols: string[] }>();
          for (const f of fks) {
            const tbl = byName.get(key(f['s'], f['n']));
            if (!tbl) continue;
            const g = grouped.get(String(f['cn'])) ?? {
              tbl,
              columns: [],
              ref: `${String(f['rs'])}.${String(f['rn'])}`,
              refCols: [],
            };
            g.columns.push(String(f['c']));
            g.refCols.push(String(f['rc']));
            grouped.set(String(f['cn']), g);
          }
          for (const g of grouped.values())
            (g.tbl.foreignKeys ??= []).push({ columns: g.columns, references: `${g.ref}(${g.refCols.join(', ')})` });
          const [idx] = await conn.query<Row[]>(
            `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, INDEX_NAME AS i, NON_UNIQUE AS nu,
                    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS c
               FROM information_schema.STATISTICS WHERE ${where.join(' AND ')}
              GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
            values,
          );
          for (const ix of idx) {
            const tbl = byName.get(key(ix['s'], ix['n']));
            if (tbl)
              (tbl.indexes ??= []).push({
                name: String(ix['i']),
                definition: `${Number(ix['nu']) === 0 ? 'UNIQUE ' : ''}(${String(ix['c'])})`,
              });
          }
        }
        return out;
      });
    },

    async close() {
      const p = pool;
      pool = undefined;
      ready = undefined;
      await p?.end().catch(() => undefined);
    },
  };
}
