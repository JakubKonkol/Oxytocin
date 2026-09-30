import type { config as MssqlConfig, ConnectionPool, IColumnMetadata, Request, Transaction } from 'mssql';
import type { ResultSet } from '../format';
import {
  stripTrailingSemicolons,
  type QueryOptions,
  type SchemaRequest,
  type SqlDriver,
  type TableInfo,
} from './driver';
import type { Target } from './target';

const IDLE_MS = 5 * 60_000;
const COUNT_LIMIT = 1_000_000;

type Column = IColumnMetadata[string] & { type?: { declaration?: string } };

/**
 * SQL Server and Azure SQL (`mssql` → `tedious`, TCP only: LocalDB's named pipes are not supported). TLS: `disable`
 * turns encryption off; every other mode encrypts and verifies the certificate unless *Trust server certificate* is on.
 */
export async function createSqlServer(t: Target, o: { timeoutMs: number }): Promise<SqlDriver> {
  const mssql = (await import('mssql')).default;
  const instanceName = t.options['instanceName']?.trim();
  const config: MssqlConfig = {
    server: t.host,
    ...(instanceName ? {} : { port: t.port ?? 1433 }),
    ...(t.database ? { database: t.database } : {}),
    ...(t.user ? { user: t.user } : {}),
    ...(t.password !== undefined ? { password: t.password } : {}),
    ...(t.options['domain'] ? { domain: t.options['domain'] } : {}),
    connectionTimeout: 10_000,
    requestTimeout: o.timeoutMs + 1000,
    pool: { max: 2, min: 0, idleTimeoutMillis: IDLE_MS },
    options: {
      encrypt: t.tls.mode !== 'disable',
      trustServerCertificate: t.tls.trustServerCertificate === true,
      appName: 'Oxytocin',
      enableArithAbort: true,
      ...(instanceName ? { instanceName } : {}),
    },
  };
  let pool: ConnectionPool | undefined;
  let ready: Promise<ConnectionPool> | undefined;
  const getPool = () => {
    ready ??= (async () => {
      const candidate = new mssql.ConnectionPool(config);
      candidate.on('error', () => undefined);
      try {
        await candidate.connect();
        pool = candidate;
        return candidate;
      } catch (e) {
        await candidate.close().catch(() => undefined);
        ready = undefined;
        throw e;
      }
    })();
    return ready;
  };

  const bind = (req: Request, params: unknown[]) => {
    params.forEach((v, i) => req.input(`p${i + 1}`, v as never));
  };

  const inTransaction = async <R>(write: boolean, fn: (tx: Transaction) => Promise<R>): Promise<R> => {
    const tx = new mssql.Transaction(await getPool());
    await tx.begin();
    let done = false;
    try {
      const result = await fn(tx);
      if (write) await tx.commit();
      else await tx.rollback();
      done = true;
      return result;
    } finally {
      if (!done) await tx.rollback().catch(() => undefined);
    }
  };

  const columnsOf = (cols: unknown): { name: string; type: string }[] => {
    const list = (Array.isArray(cols) ? cols : Object.values(cols as Record<string, Column>)) as Column[];
    return list.map((c) => ({ name: c.name, type: (c.type?.declaration ?? '').toLowerCase() }));
  };

  const streamRead = (tx: Transaction, sql: string, params: unknown[], q: QueryOptions) =>
    new Promise<ResultSet>((resolve, reject) => {
      const req = new mssql.Request(tx);
      req.stream = true;
      req.arrayRowMode = true;
      bind(req, params);
      let columns: { name: string; type: string }[] | undefined;
      const rows: unknown[][] = [];
      let count = 0;
      let recordset = 0;
      let cancelled = false;
      req.on('recordset', (cols: unknown) => {
        recordset++;
        if (recordset === 1) columns = columnsOf(cols);
      });
      req.on('row', (row: unknown) => {
        if (recordset !== 1) return;
        count++;
        if (rows.length <= q.maxRows) rows.push(row as unknown[]);
        else if (count > q.maxRows + COUNT_LIMIT && !cancelled) {
          cancelled = true;
          req.cancel();
        }
      });
      req.on('error', (e: unknown) => {
        if (!cancelled) reject(e instanceof Error ? e : new Error(String(e)));
      });
      req.on('done', (r: { rowsAffected?: number[] }) => {
        if (!columns)
          resolve({
            columns: [],
            rows: [],
            total: 0,
            ...(r.rowsAffected?.length ? { affected: r.rowsAffected[0]! } : {}),
          });
        else resolve({ columns, rows, total: cancelled ? null : count });
      });
      void req.query(sql);
    });

  return {
    family: 'sql',
    async version() {
      const r = await (
        await getPool()
      )
        .request()
        .query<{ v: string; e: string }>(
          "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(100)) AS e",
        );
      const row = r.recordset[0];
      return `SQL Server ${row?.v ?? ''}${row?.e ? ` (${row.e})` : ''}`;
    },

    async query(sql, params, q) {
      const text = stripTrailingSemicolons(sql);
      return inTransaction(q.write, async (tx) => {
        if (!q.write) return streamRead(tx, text, params, q);
        const req = new mssql.Request(tx);
        req.arrayRowMode = true;
        bind(req, params);
        const r = await req.query(text);
        const first = r.recordset as unknown as (unknown[][] & { columns?: unknown }) | undefined;
        if (first && (r as unknown as { columns?: unknown[] }).columns) {
          const columns = columnsOf((r as unknown as { columns: unknown[] }).columns[0]);
          return { columns, rows: first, total: first.length };
        }
        const affected = r.rowsAffected.reduce((a, b) => a + b, 0);
        return { columns: [], rows: [], total: 0, affected, command: `${affected} affected` };
      });
    },

    async schema(r: SchemaRequest): Promise<TableInfo[]> {
      return inTransaction(false, async (tx) => {
        const req = new mssql.Request(tx);
        const where = ["t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')"];
        if (r.schema) {
          req.input('schema', r.schema);
          where.push('t.TABLE_SCHEMA = @schema');
        }
        if (r.table) {
          req.input('table', r.table);
          where.push('t.TABLE_NAME = @table');
        }
        const tables = await req.query<{ s: string; n: string; k: string; r: number | null }>(
          `SELECT TOP 2000 t.TABLE_SCHEMA AS s, t.TABLE_NAME AS n, t.TABLE_TYPE AS k,
                  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME)) AND p.index_id IN (0, 1)) AS r
             FROM INFORMATION_SCHEMA.TABLES t WHERE ${where.join(' AND ')} ORDER BY 1, 2`,
        );
        const out: TableInfo[] = tables.recordset.map((x) => ({
          schema: x.s,
          name: x.n,
          type: x.k === 'VIEW' ? 'view' : 'table',
          ...(x.r !== null ? { rows: Number(x.r) } : {}),
        }));
        if (!r.schema && !r.table) return out;
        const byName = new Map(out.map((x) => [`${x.schema}.${x.name}`, x]));
        const creq = new mssql.Request(tx);
        if (r.schema) creq.input('schema', r.schema);
        if (r.table) creq.input('table', r.table);
        const cols = await creq.query<{
          s: string;
          n: string;
          c: string;
          t: string;
          l: number | null;
          p: number | null;
          sc: number | null;
          nl: string;
          d: string | null;
        }>(
          `SELECT t.TABLE_SCHEMA AS s, t.TABLE_NAME AS n, t.COLUMN_NAME AS c, t.DATA_TYPE AS t, t.CHARACTER_MAXIMUM_LENGTH AS l,
                  t.NUMERIC_PRECISION AS p, t.NUMERIC_SCALE AS sc, t.IS_NULLABLE AS nl, t.COLUMN_DEFAULT AS d
             FROM INFORMATION_SCHEMA.COLUMNS t WHERE ${where.join(' AND ')} ORDER BY 1, 2, t.ORDINAL_POSITION`,
        );
        for (const c of cols.recordset) {
          const tbl = byName.get(`${c.s}.${c.n}`);
          if (!tbl) continue;
          const size =
            c.l !== null
              ? `(${c.l === -1 ? 'max' : c.l})`
              : /decimal|numeric/.test(c.t) && c.p !== null
                ? `(${c.p},${c.sc ?? 0})`
                : '';
          (tbl.columns ??= []).push({ name: c.c, type: `${c.t}${size}`, nullable: c.nl === 'YES', default: c.d });
        }
        if (r.table) {
          for (const tbl of out) {
            const kreq = new mssql.Request(tx);
            kreq.input('obj', `${tbl.schema}.${tbl.name}`);
            const pk = await kreq.query<{ c: string }>(
              `SELECT c.name AS c FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE i.object_id = OBJECT_ID(@obj) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`,
            );
            if (pk.recordset.length) tbl.primaryKey = pk.recordset.map((x) => x.c);
            const freq = new mssql.Request(tx);
            freq.input('obj', `${tbl.schema}.${tbl.name}`);
            const fks = await freq.query<{ n: string; c: string; rt: string; rc: string }>(
              `SELECT fk.name AS n, pc.name AS c, SCHEMA_NAME(rt.schema_id) + '.' + rt.name AS rt, rc.name AS rc
                 FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                 JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                WHERE fk.parent_object_id = OBJECT_ID(@obj) ORDER BY fk.name, fkc.constraint_column_id`,
            );
            const grouped = new Map<string, { columns: string[]; ref: string; refCols: string[] }>();
            for (const f of fks.recordset) {
              const g = grouped.get(f.n) ?? { columns: [], ref: f.rt, refCols: [] };
              g.columns.push(f.c);
              g.refCols.push(f.rc);
              grouped.set(f.n, g);
            }
            for (const g of grouped.values())
              (tbl.foreignKeys ??= []).push({ columns: g.columns, references: `${g.ref}(${g.refCols.join(', ')})` });
            const ireq = new mssql.Request(tx);
            ireq.input('obj', `${tbl.schema}.${tbl.name}`);
            const idx = await ireq.query<{ n: string; u: boolean; t: string; c: string }>(
              `SELECT i.name AS n, i.is_unique AS u, i.type_desc AS t,
                      STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS c
                 FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@obj) AND i.name IS NOT NULL`,
            );
            for (const ix of idx.recordset)
              (tbl.indexes ??= []).push({
                name: ix.n,
                definition: `${ix.u ? 'UNIQUE ' : ''}${ix.t.toLowerCase()} (${ix.c ?? ''})`,
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
      await p?.close().catch(() => undefined);
    },
  };
}
