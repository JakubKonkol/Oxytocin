import { access, constants } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { ResultSet } from '../format';
import { stripTrailingSemicolons, type SqlDriver, type TableInfo } from './driver';
import type { Target } from './target';

const COUNT_LIMIT = 1_000_000;

/**
 * The worker that runs SQLite (`node:sqlite` is synchronous: a long query must not block the host, and a timeout
 * terminates the worker). Read-only work opens the file with `readOnly: true`; extensions cannot be loaded.
 */
const WORKER = String.raw`
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const dbs = new Map();
function open(path, write) {
  const key = (write ? 'w:' : 'r:') + path;
  let db = dbs.get(key);
  if (!db) {
    db = new DatabaseSync(path, { readOnly: !write, timeout: 5000, allowExtension: false });
    dbs.set(key, db);
  }
  return db;
}
function columnsOf(stmt) {
  try { return stmt.columns().map((c) => ({ name: c.name, type: (c.type || '').toLowerCase() })); } catch { return null; }
}
function query(m) {
  const db = open(m.path, m.write);
  if (m.write) db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(m.sql);
    stmt.setReadBigInts(true);
    let columns = columnsOf(stmt);
    let result;
    if (columns && columns.length === 0) {
      const r = stmt.run(...m.params);
      result = { columns: [], rows: [], total: 0, affected: Number(r.changes), command: Number(r.changes) + ' affected' };
    } else {
      if (typeof stmt.setReturnArrays === 'function') stmt.setReturnArrays(true);
      const rows = [];
      let count = 0;
      let total = null;
      let keys = null;
      for (const row of stmt.iterate(...m.params)) {
        count++;
        if (rows.length <= m.maxRows) {
          if (Array.isArray(row)) rows.push(row);
          else { keys = keys || Object.keys(row); rows.push(keys.map((k) => row[k])); }
        } else if (count > m.maxRows + m.countLimit) break;
      }
      total = count > m.maxRows + m.countLimit ? null : count;
      if (!columns) columns = (keys || []).map((name) => ({ name, type: '' }));
      result = { columns, rows, total };
    }
    if (m.write) db.exec('COMMIT');
    return result;
  } catch (e) {
    if (m.write) { try { db.exec('ROLLBACK'); } catch {} }
    throw e;
  }
}
function all(db, sql, ...params) { return db.prepare(sql).all(...params); }
function schema(m) {
  const db = open(m.path, false);
  const tables = all(db, "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " + (m.table ? 'AND name = ? ' : '') + 'ORDER BY name', ...(m.table ? [m.table] : []));
  return tables.map((t) => {
    const info = { name: t.name, type: t.type };
    if (m.table || m.schema) {
      const cols = all(db, 'SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info(?)', t.name);
      info.columns = cols.map((c) => ({ name: c.name, type: c.type || 'any', nullable: !c.nn, default: c.d }));
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      if (pk.length) info.primaryKey = pk;
      if (m.table) {
        const fks = all(db, 'SELECT id, "from" AS f, "table" AS t, "to" AS c FROM pragma_foreign_key_list(?) ORDER BY id, seq', t.name);
        const grouped = new Map();
        for (const f of fks) {
          const g = grouped.get(f.id) || { columns: [], table: f.t, refs: [] };
          g.columns.push(f.f); g.refs.push(f.c || '?'); grouped.set(f.id, g);
        }
        if (grouped.size) info.foreignKeys = [...grouped.values()].map((g) => ({ columns: g.columns, references: g.table + '(' + g.refs.join(', ') + ')' }));
        const idx = all(db, 'SELECT name, "unique" AS u FROM pragma_index_list(?)', t.name);
        if (idx.length) info.indexes = idx.map((i) => ({ name: i.name, definition: (i.u ? 'UNIQUE ' : '') + '(' + all(db, 'SELECT name FROM pragma_index_info(?)', i.name).map((c) => c.name).join(', ') + ')' }));
      }
    }
    try { if (t.type === 'table' && (m.table || m.schema)) info.rows = Number(all(db, 'SELECT count(*) AS n FROM "' + t.name.replace(/"/g, '""') + '"')[0].n); } catch {}
    return info;
  });
}
parentPort.on('message', (m) => {
  try {
    let result;
    if (m.op === 'version') result = 'SQLite ' + all(open(m.path, false), 'SELECT sqlite_version() AS v')[0].v;
    else if (m.op === 'query') result = query(m);
    else if (m.op === 'schema') result = schema(m);
    else if (m.op === 'close') { for (const db of dbs.values()) { try { db.close(); } catch {} } dbs.clear(); result = null; }
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: { message: e && e.message ? e.message : String(e), code: e && (e.errcode || e.code) } });
  }
});
`;

class SqliteError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** SQLite files through `node:sqlite` in a worker thread. */
export function createSqlite(t: Target): SqlDriver {
  const path = t.path!;
  let worker: Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const getWorker = () => {
    if (worker) return worker;
    const w = new Worker(WORKER, { eval: true });
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: { message: string; code?: string } }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else
        p.reject(new SqliteError(m.error?.message ?? 'SQLite error', m.error?.code ? String(m.error.code) : undefined));
    });
    const fail = (e: unknown) => {
      if (worker === w) worker = undefined;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    w.on('error', fail);
    w.on('exit', () => fail(new Error('The SQLite worker stopped')));
    worker = w;
    return w;
  };

  const call = <R>(message: Record<string, unknown>, timeoutMs: number): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = nextId++;
      const w = getWorker();
      const timer = setTimeout(() => {
        pending.delete(id);
        // A query cannot be interrupted: end the worker (the next call starts a new one).
        if (worker === w) worker = undefined;
        void w.terminate();
        reject(new SqliteError(`Query timeout: stopped after ${Math.round(timeoutMs / 1000)} s`, 'TIMEOUT'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as R);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      });
      w.postMessage({ id, ...message });
    });

  const ensureFile = async () => {
    try {
      await access(path, constants.R_OK);
    } catch {
      throw new SqliteError(`The database file does not exist: ${path}`, 'ENOENT');
    }
  };

  return {
    family: 'sql',
    async version(timeoutMs) {
      await ensureFile();
      return call<string>({ op: 'version', path }, timeoutMs);
    },
    async query(sql, params, q): Promise<ResultSet> {
      await ensureFile();
      return call<ResultSet>(
        {
          op: 'query',
          path,
          sql: stripTrailingSemicolons(sql),
          params: params.map((p) => (typeof p === 'boolean' ? Number(p) : p)),
          maxRows: q.maxRows,
          write: q.write,
          countLimit: COUNT_LIMIT,
        },
        q.timeoutMs,
      );
    },
    async schema(r): Promise<TableInfo[]> {
      await ensureFile();
      return call<TableInfo[]>({ op: 'schema', path, table: r.table, schema: r.schema }, r.timeoutMs);
    },
    async close() {
      const w = worker;
      worker = undefined;
      if (!w) return;
      await Promise.race([
        new Promise((resolve) => {
          const id = nextId++;
          pending.set(id, { resolve, reject: resolve });
          w.postMessage({ id, op: 'close' });
        }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      await w.terminate();
    },
  };
}
