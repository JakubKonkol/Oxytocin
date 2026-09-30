import type { Connection, Pool } from 'oracledb';
import type { ResultSet } from '../format';
import { stripTrailingSemicolons, type SqlDriver, type TableInfo } from './driver';
import type { Target } from './target';

/**
 * Oracle Database through `oracledb` in thin mode (pure JavaScript, no Oracle Client). Reads run in
 * `SET TRANSACTION READ ONLY` transactions that are rolled back; `database` is the service name (or the SID when the
 * `sid` option is set).
 */
export async function createOracle(t: Target): Promise<SqlDriver> {
  const oracledb = (await import('oracledb')).default;
  const tcps = t.tls.mode === 'require' || t.tls.mode === 'verify';
  const port = t.port ?? 1521;
  const service = t.database ?? 'FREEPDB1';
  const connectString =
    t.options['sid'] === 'true'
      ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=${tcps ? 'TCPS' : 'TCP'})(HOST=${t.host})(PORT=${port}))(CONNECT_DATA=(SID=${service})))`
      : `${tcps ? 'tcps://' : ''}${t.host}:${port}/${service}`;
  let pool: Pool | undefined;
  let ready: Promise<Pool> | undefined;
  const getPool = () => {
    ready ??= oracledb
      .createPool({
        ...(t.user ? { user: t.user } : {}),
        ...(t.password !== undefined ? { password: t.password } : {}),
        connectString,
        poolMin: 0,
        poolMax: 2,
        poolIncrement: 1,
        poolTimeout: 300,
        queueTimeout: 15_000,
        connectTimeout: 10,
        ...(t.tls.mode === 'require' ? { sslServerDNMatch: false } : {}),
      })
      .then(
        (p) => (pool = p),
        (e: unknown) => {
          ready = undefined;
          throw e;
        },
      );
    return ready;
  };

  const withConnection = async <R>(timeoutMs: number, fn: (c: Connection) => Promise<R>): Promise<R> => {
    const conn = await (await getPool()).getConnection();
    conn.callTimeout = timeoutMs;
    try {
      return await fn(conn);
    } finally {
      await conn.rollback().catch(() => undefined);
      await conn.close().catch(() => undefined);
    }
  };

  const columns = (meta: { name: string; dbTypeName?: string }[] | undefined) =>
    (meta ?? []).map((m) => ({ name: m.name, type: (m.dbTypeName ?? '').toLowerCase() }));

  const opts = {
    outFormat: oracledb.OUT_FORMAT_ARRAY,
    fetchTypeHandler: (meta: { dbType?: unknown }) =>
      meta.dbType === oracledb.DB_TYPE_CLOB ||
      meta.dbType === oracledb.DB_TYPE_NCLOB ||
      meta.dbType === oracledb.DB_TYPE_JSON
        ? { type: oracledb.STRING }
        : meta.dbType === oracledb.DB_TYPE_BLOB
          ? { type: oracledb.BUFFER }
          : undefined,
  };

  return {
    family: 'sql',
    async version(timeoutMs) {
      return withConnection(timeoutMs, (c) => Promise.resolve(`Oracle Database ${c.oracleServerVersionString}`));
    },
    async query(sql, params, q): Promise<ResultSet> {
      const text = stripTrailingSemicolons(sql);
      return withConnection(q.timeoutMs, async (c) => {
        if (!q.write) {
          await c.execute('SET TRANSACTION READ ONLY');
          const r = await c.execute<unknown[]>(text, params as never[], { ...opts, maxRows: q.maxRows + 1 });
          const rows = r.rows ?? [];
          return { columns: columns(r.metaData), rows, total: rows.length > q.maxRows ? null : rows.length };
        }
        const r = await c.execute<unknown[]>(text, params as never[], { ...opts, autoCommit: false });
        await c.commit();
        if (r.metaData?.length) return { columns: columns(r.metaData), rows: r.rows ?? [], total: r.rows?.length ?? 0 };
        const affected = r.rowsAffected ?? 0;
        return { columns: [], rows: [], total: 0, affected, command: `${affected} affected` };
      });
    },
    async schema(r): Promise<TableInfo[]> {
      return withConnection(r.timeoutMs, async (c) => {
        await c.execute('SET TRANSACTION READ ONLY');
        const owner = r.schema ? r.schema.toUpperCase() : undefined;
        const ownerSql = owner ? ':owner' : "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')";
        const binds: Record<string, string> = owner ? { owner } : {};
        const tableFilter = r.table ? ' AND UPPER(name) = UPPER(:tbl)' : '';
        if (r.table) binds['tbl'] = r.table;
        const tables = await c.execute<[string, string, string, number | null]>(
          `SELECT owner, name, kind, num_rows FROM (
             SELECT owner, table_name AS name, 'table' AS kind, num_rows FROM all_tables WHERE owner = ${ownerSql}
             UNION ALL SELECT owner, view_name, 'view', NULL FROM all_views WHERE owner = ${ownerSql})
           WHERE 1 = 1${tableFilter} ORDER BY name FETCH FIRST 2000 ROWS ONLY`,
          binds,
          { outFormat: oracledb.OUT_FORMAT_ARRAY },
        );
        const out: TableInfo[] = (tables.rows ?? []).map(([schema, name, kind, rows]) => ({
          schema,
          name,
          type: kind,
          ...(rows !== null ? { rows: Number(rows) } : {}),
        }));
        if (!r.schema && !r.table) return out;
        const byName = new Map(out.map((x) => [x.name, x]));
        const cols = await c.execute<
          [string, string, string, number | null, number | null, number | null, string, string | null]
        >(
          `SELECT table_name, column_name, data_type, data_length, data_precision, data_scale, nullable, data_default
             FROM all_tab_columns WHERE owner = ${ownerSql}${r.table ? ' AND UPPER(table_name) = UPPER(:tbl)' : ''} ORDER BY table_name, column_id`,
          binds,
          { outFormat: oracledb.OUT_FORMAT_ARRAY },
        );
        for (const [table, name, type, length, precision, scale, nullable, def] of cols.rows ?? []) {
          const tbl = byName.get(table);
          if (!tbl) continue;
          const size =
            type === 'NUMBER' && precision !== null
              ? `(${precision}${scale ? `,${scale}` : ''})`
              : /CHAR/.test(type) && length
                ? `(${length})`
                : '';
          (tbl.columns ??= []).push({
            name,
            type: `${type}${size}`,
            nullable: nullable === 'Y',
            default: def?.trim() || null,
          });
        }
        if (r.table) {
          const cons = await c.execute<[string, string, string, string, string | null]>(
            `SELECT ac.table_name, ac.constraint_type, ac.constraint_name, acc.column_name,
                    (SELECT rc.table_name FROM all_constraints rc WHERE rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name)
               FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
              WHERE ac.owner = ${ownerSql} AND UPPER(ac.table_name) = UPPER(:tbl) AND ac.constraint_type IN ('P', 'R')
              ORDER BY ac.constraint_name, acc.position`,
            binds,
            { outFormat: oracledb.OUT_FORMAT_ARRAY },
          );
          const fks = new Map<string, { columns: string[]; ref: string }>();
          for (const [table, type, name, column, ref] of cons.rows ?? []) {
            const tbl = byName.get(table);
            if (!tbl) continue;
            if (type === 'P') (tbl.primaryKey ??= []).push(column);
            else {
              const g = fks.get(name) ?? { columns: [], ref: ref ?? '?' };
              g.columns.push(column);
              fks.set(name, g);
            }
          }
          const tbl = out[0];
          if (tbl)
            for (const g of fks.values()) (tbl.foreignKeys ??= []).push({ columns: g.columns, references: g.ref });
          const idx = await c.execute<[string, string, string]>(
            `SELECT i.index_name, i.uniqueness, LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
               FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
              WHERE i.table_owner = ${ownerSql} AND UPPER(i.table_name) = UPPER(:tbl) GROUP BY i.index_name, i.uniqueness`,
            binds,
            { outFormat: oracledb.OUT_FORMAT_ARRAY },
          );
          if (tbl)
            for (const [name, uniq, cols2] of idx.rows ?? [])
              (tbl.indexes ??= []).push({ name, definition: `${uniq === 'UNIQUE' ? 'UNIQUE ' : ''}(${cols2})` });
        }
        return out;
      });
    },
    async close() {
      const p = pool;
      pool = undefined;
      ready = undefined;
      await p?.close(0).catch(() => undefined);
    },
  };
}
