import type { Pool, PoolClient, PoolConfig } from 'pg';
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
/** Text types whose values stay as the server prints them (no time zone surprises). */
const RAW_TYPES = [1082, 1083, 1114, 1184, 1266, 1186];
const CURSORABLE = /^\s*(\(\s*)*(select|with|values|table)\b/i;

const stripLeadingComments = (sql: string) => sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, '');

/** PostgreSQL and CockroachDB (`pg`). */
export async function createPostgres(t: Target, o: { root: string; readOnly: boolean }): Promise<SqlDriver> {
  const { default: pg } = await import('pg');
  const tls = await tlsOptions(t, o.root);
  const types = {
    getTypeParser: (oid: number, format?: 'text' | 'binary') =>
      RAW_TYPES.includes(oid)
        ? (v: string) => v
        : (pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown),
  };
  const base: PoolConfig = {
    host: t.host,
    ...(t.port ? { port: t.port } : {}),
    ...(t.database ? { database: t.database } : {}),
    ...(t.user ? { user: t.user } : {}),
    ...(t.password !== undefined ? { password: t.password } : {}),
    max: 2,
    idleTimeoutMillis: IDLE_MS,
    connectionTimeoutMillis: 10_000,
    application_name: 'Oxytocin',
    types,
  };
  // Defense in depth for read-only resources: every transaction of the session is read-only (not for CockroachDB,
  // whose connection options differ; its reads still run in READ ONLY transactions).
  const readOnlyOption = o.readOnly && t.engine === 'postgresql' ? ['-c default_transaction_read_only=on'] : [];
  const sslVariants: PoolConfig['ssl'][] = tls === null ? [false] : t.tls.mode === 'prefer' ? [tls, false] : [tls];
  const variants: PoolConfig[] = [];
  for (const ssl of sslVariants) {
    for (const options of [...readOnlyOption, undefined])
      variants.push({ ...base, ssl, ...(options ? { options } : {}) });
  }
  let pool: Pool | undefined;
  let poolReady: Promise<Pool> | undefined;
  const typeNames = new Map<number, string>();

  const getPool = () => {
    poolReady ??= firstWorking(
      variants,
      async (config) => {
        const candidate = new pg.Pool(config);
        candidate.on('error', () => undefined);
        try {
          const client = await candidate.connect();
          client.release();
          return candidate;
        } catch (e) {
          await candidate.end().catch(() => undefined);
          throw e;
        }
      },
      (e) => isNoTlsError(e) || /unsupported startup parameter|default_transaction_read_only/i.test(String(e)),
    ).then(
      (p) => (pool = p),
      (e: unknown) => {
        poolReady = undefined;
        throw e;
      },
    );
    return poolReady;
  };

  const withClient = async <R>(fn: (client: PoolClient) => Promise<R>): Promise<R> => {
    const client = await (await getPool()).connect();
    let broken = false;
    try {
      return await fn(client);
    } catch (e) {
      broken = /Connection terminated|ECONNRESET|timeout/i.test(String(e));
      throw e;
    } finally {
      client.release(broken);
    }
  };

  const nameTypes = async (client: PoolClient, oids: number[]) => {
    const missing = [...new Set(oids)].filter((id) => !typeNames.has(id));
    if (missing.length === 0) return;
    const r = await client.query<{ oid: number; name: string }>(
      'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
      [missing],
    );
    for (const row of r.rows) typeNames.set(row.oid, row.name);
  };

  return {
    family: 'sql',
    async version(timeoutMs) {
      return withClient(async (client) => {
        await client.query(`SET statement_timeout = ${Math.round(timeoutMs)}`);
        const r = await client.query<{ v: string }>('SELECT version() AS v');
        await client.query('RESET statement_timeout');
        const v = r.rows[0]?.v ?? '';
        const cockroach = /CockroachDB[^,(]*/.exec(v)?.[0];
        if (cockroach) return cockroach.trim();
        const pgv = /PostgreSQL [\d.]+\w*/.exec(v)?.[0];
        return pgv ?? v.slice(0, 80);
      });
    },

    async query(sql, params, q: QueryOptions): Promise<ResultSet> {
      const text = stripTrailingSemicolons(sql);
      return withClient(async (client) => {
        await client.query(q.write ? 'BEGIN' : 'BEGIN READ ONLY');
        let done = false;
        try {
          await client.query(`SET LOCAL statement_timeout = ${Math.round(q.timeoutMs)}`);
          let result: ResultSet;
          if (!q.write && CURSORABLE.test(stripLeadingComments(text))) {
            await client.query({ text: `DECLARE oxy_cursor NO SCROLL CURSOR FOR ${text}`, values: params });
            const r = await client.query({ text: `FETCH FORWARD ${q.maxRows + 1} FROM oxy_cursor`, rowMode: 'array' });
            let total: number | null = r.rows.length;
            if (r.rows.length > q.maxRows) {
              try {
                await client.query(`SET LOCAL statement_timeout = ${Math.min(Math.round(q.timeoutMs), 5000)}`);
                const moved = await client.query('MOVE FORWARD ALL FROM oxy_cursor');
                total = r.rows.length + (moved.rowCount ?? 0);
              } catch {
                total = null;
              }
            }
            await nameTypes(
              client,
              r.fields.map((f) => f.dataTypeID),
            ).catch(() => undefined);
            result = {
              columns: r.fields.map((f) => ({
                name: f.name,
                type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID),
              })),
              rows: r.rows as unknown[][],
              total,
            };
          } else {
            const r = await client.query({ text, values: params, rowMode: 'array' });
            const fields = r.fields ?? [];
            if (fields.length)
              await nameTypes(
                client,
                fields.map((f) => f.dataTypeID),
              ).catch(() => undefined);
            result = {
              columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID) })),
              rows: (r.rows ?? []) as unknown[][],
              total: fields.length ? (r.rows?.length ?? 0) : 0,
              ...(q.write && r.command
                ? { command: `${r.command}${r.rowCount !== null ? ` ${r.rowCount}` : ''}` }
                : {}),
              ...(q.write && r.rowCount !== null ? { affected: r.rowCount } : {}),
            };
          }
          await client.query(q.write ? 'COMMIT' : 'ROLLBACK');
          done = true;
          return result;
        } finally {
          if (!done) await client.query('ROLLBACK').catch(() => undefined);
        }
      });
    },

    async schema(r: SchemaRequest): Promise<TableInfo[]> {
      return withClient(async (client) => {
        await client.query('BEGIN READ ONLY');
        try {
          await client.query(`SET LOCAL statement_timeout = ${Math.round(r.timeoutMs)}`);
          const filters: string[] = [
            "c.relkind IN ('r','v','m','p','f')",
            "n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal','pg_extension')",
            "n.nspname NOT LIKE 'pg\\_toast%'",
            "n.nspname NOT LIKE 'pg\\_temp%'",
          ];
          const values: unknown[] = [];
          if (r.schema) {
            values.push(r.schema);
            filters.push(`n.nspname = $${values.length}`);
          }
          if (r.table) {
            values.push(r.table);
            filters.push(`c.relname = $${values.length}`);
          }
          const tables = await client.query<{
            oid: number;
            schema: string;
            name: string;
            kind: string;
            rows: string;
            comment: string | null;
          }>(
            `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                    c.reltuples::bigint::text AS rows, obj_description(c.oid, 'pg_class') AS comment
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE ${filters.join(' AND ')}
              ORDER BY 2, 3 LIMIT 2000`,
            values,
          );
          const kinds: Record<string, string> = {
            r: 'table',
            p: 'table',
            v: 'view',
            m: 'materialized view',
            f: 'foreign table',
          };
          const out: TableInfo[] = tables.rows.map((t) => ({
            schema: t.schema,
            name: t.name,
            type: kinds[t.kind] ?? t.kind,
            ...(Number(t.rows) >= 0 ? { rows: Number(t.rows) } : {}),
            ...(t.comment ? { comment: t.comment } : {}),
          }));
          if (!r.schema && !r.table) return out;
          const oids = tables.rows.map((t) => t.oid);
          const cols = await client.query<{
            oid: number;
            name: string;
            type: string;
            notnull: boolean;
            def: string | null;
          }>(
            `SELECT a.attrelid::int AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                    a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
               FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attrelid, a.attnum`,
            [oids],
          );
          const byOid = new Map(tables.rows.map((t, i) => [t.oid, out[i]!]));
          for (const c of cols.rows) {
            const t = byOid.get(c.oid);
            if (!t) continue;
            (t.columns ??= []).push({ name: c.name, type: c.type, nullable: !c.notnull, default: c.def });
          }
          if (r.table) {
            const cons = await client.query<{ oid: number; type: string; def: string; cols: string[] | null }>(
              `SELECT conrelid::int AS oid, contype AS type, pg_get_constraintdef(oid) AS def,
                      (SELECT array_agg(attname::text ORDER BY k.i) FROM unnest(conkey) WITH ORDINALITY k(n, i)
                         JOIN pg_attribute ON attrelid = conrelid AND attnum = k.n) AS cols
                 FROM pg_constraint WHERE conrelid = ANY($1::oid[]) AND contype IN ('p', 'f')`,
              [oids],
            );
            for (const c of cons.rows) {
              const t = byOid.get(c.oid);
              if (!t) continue;
              if (c.type === 'p') t.primaryKey = c.cols ?? [];
              else {
                const ref = /REFERENCES\s+(.+?)(\s+ON\s+|\s+MATCH\s+|\s+DEFERRABLE|$)/i.exec(c.def)?.[1] ?? c.def;
                (t.foreignKeys ??= []).push({ columns: c.cols ?? [], references: ref });
              }
            }
            const idx = await client.query<{ oid: number; name: string; def: string }>(
              `SELECT indrelid::int AS oid, i.relname AS name, pg_get_indexdef(indexrelid) AS def
                 FROM pg_index JOIN pg_class i ON i.oid = indexrelid WHERE indrelid = ANY($1::oid[])`,
              [oids],
            );
            for (const ix of idx.rows) {
              const t = byOid.get(ix.oid);
              if (t) (t.indexes ??= []).push({ name: ix.name, definition: ix.def.replace(/^CREATE\s+/i, '') });
            }
          }
          return out;
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
        }
      });
    },

    async close() {
      const p = pool;
      pool = undefined;
      poolReady = undefined;
      await p?.end().catch(() => undefined);
    },
  };
}
