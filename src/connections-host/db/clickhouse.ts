import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import { readFile } from 'node:fs/promises';
import type { ResultSet } from '../format';
import { stripTrailingSemicolons, type SqlDriver, type TableInfo } from './driver';
import type { Target } from './target';
import { projectPath } from './target';
import { scalarText } from '@shared/utils/text';

const params = (values: unknown[]) => Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
/** The account itself is read-only (`readonly=1`): it cannot change settings, so queries run without any. */
const isReadonlyAccount = (e: unknown) => /Cannot modify '?\w+'? setting in readonly mode/i.test(String(e));

/**
 * ClickHouse over its HTTP interface (`@clickhouse/client`). Reads run with the server setting `readonly=2`
 * (server-enforced: only reads, settings may change), a time limit and a row limit.
 */
export async function createClickHouse(t: Target, o: { root: string; timeoutMs: number }): Promise<SqlDriver> {
  const { createClient } = await import('@clickhouse/client');
  const https = t.tls.mode === 'require' || t.tls.mode === 'verify';
  const ca = t.tls.mode === 'verify' && t.tls.caPath ? await readFile(projectPath(o.root, t.tls.caPath)) : undefined;
  const client: ClickHouseClient = createClient({
    url: `${https ? 'https' : 'http'}://${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port ?? (https ? 8443 : 8123)}`,
    ...(t.user ? { username: t.user } : {}),
    ...(t.password !== undefined ? { password: t.password } : {}),
    ...(t.database ? { database: t.database } : {}),
    request_timeout: o.timeoutMs + 5000,
    max_open_connections: 2,
    application: 'Oxytocin',
    ...(ca ? { tls: { ca_cert: ca } } : {}),
  });

  const read = async (sql: string, values: unknown[], maxRows: number, timeoutMs: number): Promise<ResultSet> => {
    const settings: ClickHouseSettings = {
      readonly: '2',
      max_execution_time: Math.max(1, Math.ceil(timeoutMs / 1000)),
      max_result_rows: String(maxRows + 1),
      result_overflow_mode: 'break',
      // Small blocks: with `break` the server stops after the block that crosses the limit, so the whole (small)
      // response is read and the connection stays reusable.
      max_block_size: String(Math.max(maxRows + 1, 64)),
    };
    const run = async (clickhouse_settings?: ClickHouseSettings) => {
      // Without settings (a read-only account) the server does not limit the rows: stop reading once there are enough.
      const limited = clickhouse_settings !== undefined;
      const rs = await client.query({
        query: sql,
        format: 'JSONCompactEachRowWithNamesAndTypes',
        query_params: params(values),
        ...(clickhouse_settings ? { clickhouse_settings } : {}),
        abort_signal: AbortSignal.timeout(timeoutMs + 2000),
      });
      const rows: unknown[][] = [];
      let header: string[] | undefined;
      let types: string[] | undefined;
      let more = false;
      for await (const batch of rs.stream()) {
        for (const row of batch) {
          const value = row.json<unknown[]>();
          if (!header) header = value as string[];
          else if (!types) types = value as string[];
          else if (rows.length <= maxRows) rows.push(value);
          else more = true;
        }
        if (!limited && (more || rows.length > maxRows)) break;
      }
      rs.close();
      return {
        columns: (header ?? []).map((name, i) => ({ name, type: types?.[i] ?? '' })),
        rows,
        total: rows.length > maxRows || more ? null : rows.length,
      };
    };
    try {
      return await run(settings);
    } catch (e) {
      if (!isReadonlyAccount(e)) throw e;
      return run();
    }
  };

  return {
    family: 'sql',
    async version(timeoutMs) {
      const r = await read('SELECT version() AS v', [], 1, timeoutMs);
      return `ClickHouse ${scalarText(r.rows[0]?.[0])}`;
    },
    async query(sql, values, q) {
      const text = stripTrailingSemicolons(sql);
      if (!q.write) return read(text, values, q.maxRows, q.timeoutMs);
      const r = await client.command({
        query: text,
        query_params: params(values),
        clickhouse_settings: { max_execution_time: Math.max(1, Math.ceil(q.timeoutMs / 1000)) },
        abort_signal: AbortSignal.timeout(q.timeoutMs + 2000),
      });
      const written = Number(r.summary?.written_rows ?? 0);
      return { columns: [], rows: [], total: 0, affected: written, command: `${written} rows written` };
    },
    async schema(r): Promise<TableInfo[]> {
      const where = [r.schema ? 'database = {db:String}' : 'database = currentDatabase()'];
      const values: Record<string, unknown> = r.schema ? { db: r.schema } : {};
      if (r.table) {
        where.push('name = {tbl:String}');
        values['tbl'] = r.table;
      }
      const tablesRs = await client.query({
        query: `SELECT database, name, engine, total_rows, sorting_key, primary_key, comment FROM system.tables
                 WHERE ${where.join(' AND ')} ORDER BY name LIMIT 2000`,
        format: 'JSONEachRow',
        query_params: values,
      });
      const tables = await tablesRs.json<{
        database: string;
        name: string;
        engine: string;
        total_rows: string | null;
        sorting_key: string;
        primary_key: string;
        comment: string;
      }>();
      const out: TableInfo[] = tables.map((x) => ({
        schema: x.database,
        name: x.name,
        type: /View/.test(x.engine) ? `view (${x.engine})` : `table (${x.engine})`,
        ...(x.total_rows !== null ? { rows: Number(x.total_rows) } : {}),
        ...(x.primary_key ? { primaryKey: x.primary_key.split(',').map((s) => s.trim()) } : {}),
        ...(x.sorting_key ? { indexes: [{ name: 'ORDER BY', definition: x.sorting_key }] } : {}),
        ...(x.comment ? { comment: x.comment } : {}),
      }));
      if (!r.schema && !r.table) return out.map(({ primaryKey: _p, indexes: _i, ...rest }) => rest);
      const colWhere = [r.schema ? 'database = {db:String}' : 'database = currentDatabase()'];
      if (r.table) colWhere.push('table = {tbl:String}');
      const colsRs = await client.query({
        query: `SELECT table, name, type, default_expression FROM system.columns WHERE ${colWhere.join(' AND ')} ORDER BY table, position`,
        format: 'JSONEachRow',
        query_params: values,
      });
      const byName = new Map(out.map((x) => [x.name, x]));
      for (const c of await colsRs.json<{ table: string; name: string; type: string; default_expression: string }>()) {
        const tbl = byName.get(c.table);
        if (tbl)
          (tbl.columns ??= []).push({
            name: c.name,
            type: c.type,
            nullable: c.type.startsWith('Nullable('),
            default: c.default_expression || null,
          });
      }
      return out;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
