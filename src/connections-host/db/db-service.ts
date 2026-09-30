import { ENGINE_INFO, type ResourceTestResult } from '@shared/domain/project-resources';
import type {
  Classification,
  DbQueryRequest,
  GuardOutcome,
  MongoRequest,
  RedisRequest,
  ResolvedDatabase,
} from '@shared/rpc/contracts/connections-host';
import { OxyError } from '@shared/errors';
import { matchesAny } from '@shared/utils/glob';
import { formatCell, formatResult, MASK, maskRows, maskValue, safeJson } from '../format';
import { classifyMongo, classifyRedis, decideNoSql } from '../guard/nosql-guard';
import { loadSqlParsers } from '../guard/parsers';
import { classifySql, decide } from '../guard/sql-guard';
import { describeError } from './errors';
import { type Driver, type MongoDriver, type RedisDriver, renderSchema, type SqlDriver } from './driver';
import { createDriver, DriverPool } from './pool';
import { resolveTarget } from './target';

const SCHEMA_CACHE_MS = 60_000;
const SCHEMA_CACHE_MAX = 200;

/** Rejects when `promise` takes longer than `ms` (a hung driver must never hang a tool call). */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${what} did not finish within ${Math.round(ms / 1000)} s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Parameters are bound, never interpolated: only JSON scalars (objects are sent as JSON text). */
function bindable(params: unknown[] | undefined): unknown[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new OxyError('INVALID', '`params` must be an array.');
  if (params.length > 1000) throw new OxyError('INVALID', 'At most 1000 parameters.');
  return params.map((p) => (p !== null && typeof p === 'object' ? JSON.stringify(p) : p));
}

const summary = (c: Classification) => `${c.statement}${c.tables.length ? ` on ${c.tables.join(', ')}` : ''}`;

/** The database side of the bridge: tests, schemas and guarded queries. */
export class DbService {
  private readonly pool = new DriverPool();
  private readonly schemaCache = new Map<string, { at: number; text: string }>();

  private async driver<D extends Driver>(db: ResolvedDatabase, family: D['family']): Promise<D> {
    const { driver } = await this.pool.get(db);
    if (driver.family !== family) throw new OxyError('INVALID', `${db.resource.name} is not a ${family} database.`);
    return driver as D;
  }

  /** A driver error as a tool error: scrubbed, with a hint; a broken connection is dropped. */
  private fail(db: ResolvedDatabase, e: unknown): never {
    if (e instanceof OxyError) throw e;
    const d = describeError(e, db.resource.engine, [...Object.values(db.secrets)]);
    if (d.kind === 'unreachable' || d.kind === 'auth' || d.kind === 'tls' || d.kind === 'config') this.pool.drop(db);
    throw new OxyError('INVALID', `${db.resource.name}: ${d.message}${d.hint ? `\nHint: ${d.hint}` : ''}`);
  }

  async test(db: ResolvedDatabase): Promise<ResourceTestResult> {
    const started = Date.now();
    let driver: Driver | undefined;
    const secrets = [...Object.values(db.secrets)];
    try {
      const target = await resolveTarget(db);
      secrets.push(...target.secrets);
      driver = await createDriver(db, target);
      const timeout = Math.min(db.resource.access.timeoutMs, 20_000);
      const version = await withDeadline(driver.version(timeout), timeout + 5000, 'the connection test');
      return { ok: true, serverVersion: version, latencyMs: Date.now() - started };
    } catch (e) {
      const d = describeError(e, db.resource.engine, secrets);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: { kind: d.kind, message: d.hint ? `${d.message}\n${d.hint}` : d.message },
      };
    } finally {
      void driver?.close().catch(() => undefined);
    }
  }

  async schema(db: ResolvedDatabase & { schema?: string; table?: string }): Promise<string> {
    const cacheKey = JSON.stringify([db.key, db.fingerprint, db.schema ?? '', db.table ?? '']);
    const cached = this.schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SCHEMA_CACHE_MS) return cached.text;
    const timeoutMs = db.resource.access.timeoutMs;
    const family = ENGINE_INFO[db.resource.engine].family;
    let text: string;
    try {
      if (family === 'sql') {
        const driver = await this.driver<SqlDriver>(db, 'sql');
        const tables = await withDeadline(
          driver.schema({
            ...(db.schema ? { schema: db.schema } : {}),
            ...(db.table ? { table: db.table } : {}),
            timeoutMs,
          }),
          timeoutMs + 5000,
          'reading the schema',
        );
        text = renderSchema(tables, db);
      } else if (family === 'mongodb') {
        const driver = await this.driver<MongoDriver>(db, 'mongodb');
        text = await withDeadline(
          driver.schema({ ...(db.table ? { collection: db.table } : {}), timeoutMs, masking: db.resource.masking }),
          timeoutMs + 5000,
          'reading the collections',
        );
      } else {
        const driver = await this.driver<RedisDriver>(db, 'redis');
        text = await withDeadline(driver.schema(timeoutMs), timeoutMs + 5000, 'reading the keyspace');
      }
    } catch (e) {
      this.fail(db, e);
    }
    // Expired entries go; the cache never holds more than a few hundred schemas.
    const now = Date.now();
    for (const [key, entry] of this.schemaCache) if (now - entry.at >= SCHEMA_CACHE_MS) this.schemaCache.delete(key);
    if (this.schemaCache.size >= SCHEMA_CACHE_MAX) this.schemaCache.delete(this.schemaCache.keys().next().value!);
    this.schemaCache.set(cacheKey, { at: now, text });
    return text;
  }

  async query(req: DbQueryRequest): Promise<GuardOutcome> {
    const { resource } = req;
    const info = ENGINE_INFO[resource.engine];
    if (info.family !== 'sql' || !info.dialect)
      throw new OxyError(
        'INVALID',
        `${resource.name} is ${info.label}: use ${info.family === 'mongodb' ? 'oxy_mongo' : 'oxy_redis'} instead of SQL.`,
      );
    if (typeof req.query !== 'string' || !req.query.trim()) throw new OxyError('INVALID', 'Pass `query`.');
    const parsers = await loadSqlParsers();
    const c = classifySql(info.dialect, req.query, parsers, { allowUserFunctions: resource.access.allowUserFunctions });
    const d = decide(resource.access.mode, c, resource.name);
    if (d.action === 'reject') return { status: 'rejected', message: d.message, classification: c };
    if (d.action === 'ask' && !req.approved)
      return { status: 'needs-approval', message: d.message, classification: c, preview: req.query };
    const params = bindable(req.params);
    const maxRows = Math.max(1, Math.min(req.maxRows ?? resource.access.maxRows, resource.access.maxRows));
    const timeoutMs = resource.access.timeoutMs;
    const write = d.action !== 'run-read';
    try {
      const driver = await this.driver<SqlDriver>(req, 'sql');
      const result = await withDeadline(
        driver.query(req.query, params, { maxRows, timeoutMs, write }),
        timeoutMs + 10_000,
        'the query',
      );
      if (write) this.invalidateSchema(req);
      const text = formatResult(maskRows(result, resource.masking), {
        format: req.format === 'json' ? 'json' : 'markdown',
        maxRows,
        maxBytes: resource.access.maxResultBytes,
      });
      return { status: 'done', text: write ? `${summary(c)} — committed.\n${text}` : text, classification: c };
    } catch (e) {
      this.fail(req, e);
    }
  }

  async mongo(req: MongoRequest): Promise<GuardOutcome> {
    const { resource } = req;
    if (resource.engine !== 'mongodb') throw new OxyError('INVALID', `${resource.name} is not a MongoDB database.`);
    if (typeof req.collection !== 'string' || !req.collection.trim())
      throw new OxyError('INVALID', 'Pass `collection`.');
    const args = req.args && typeof req.args === 'object' ? req.args : {};
    const c = classifyMongo(req.collection, req.operation, args);
    const d = decideNoSql(resource.access.mode, c, resource.name);
    if (d.action === 'reject') return { status: 'rejected', message: d.message, classification: c };
    if (d.action === 'ask' && !req.approved)
      return {
        status: 'needs-approval',
        message: d.message,
        classification: c,
        preview: safeJson({ collection: req.collection, operation: req.operation, ...args }, 2),
      };
    const maxRows = Math.max(1, Math.min(req.maxRows ?? resource.access.maxRows, resource.access.maxRows));
    const timeoutMs = resource.access.timeoutMs;
    try {
      const driver = await this.driver<MongoDriver>(req, 'mongodb');
      const r = await withDeadline(
        driver.run(req.collection, req.operation, args, { maxRows, timeoutMs }),
        timeoutMs + 10_000,
        'the operation',
      );
      const { toExtendedJson } = await import('./mongo');
      if (r.documents) {
        const docs = r.documents.map((doc) => maskValue(doc, resource.masking));
        const budget = resource.access.maxResultBytes - 512;
        const lines: string[] = [];
        let bytes = 0;
        for (const doc of docs) {
          const line = await toExtendedJson(doc);
          if (bytes + line.length > budget) break;
          bytes += line.length + 1;
          lines.push(line);
        }
        const total = r.total ?? null;
        const shown = lines.length;
        const header =
          shown < docs.length
            ? `${shown} of ${total ?? `more than ${docs.length}`} documents shown (the ${Math.round(resource.access.maxResultBytes / 1024)} KB result limit) — add a projection or a filter.`
            : r.more
              ? `${shown} of ${total !== null ? total.toLocaleString('en-US') : `more than ${shown}`} documents shown — add a filter or a limit.`
              : `${shown} document${shown === 1 ? '' : 's'}.`;
        return { status: 'done', text: `${header}\n${lines.join('\n')}`, classification: c };
      }
      return {
        status: 'done',
        text: `${c.kind === 'write' ? `${req.operation} on ${req.collection}: ` : ''}${await toExtendedJson(maskValue(r.value ?? null, resource.masking))}`,
        classification: c,
      };
    } catch (e) {
      this.fail(req, e);
    }
  }

  async redis(req: RedisRequest): Promise<GuardOutcome> {
    const { resource } = req;
    if (resource.engine !== 'redis') throw new OxyError('INVALID', `${resource.name} is not a Redis database.`);
    const args = Array.isArray(req.args) ? req.args.map((a) => String(a)) : [];
    const c = classifyRedis(req.command ?? '', args);
    const d = decideNoSql(resource.access.mode, c, resource.name);
    if (d.action === 'reject') return { status: 'rejected', message: d.message, classification: c };
    if (d.action === 'ask' && !req.approved)
      return {
        status: 'needs-approval',
        message: d.message,
        classification: c,
        preview: [c.statement, ...args].join(' '),
      };
    try {
      const driver = await this.driver<RedisDriver>(req, 'redis');
      const timeoutMs = resource.access.timeoutMs;
      const value = await withDeadline(driver.call(c.statement, args, timeoutMs), timeoutMs + 5000, 'the command');
      return {
        status: 'done',
        text: formatRedis(c.statement, args, value, resource.masking, resource.access.maxResultBytes),
        classification: c,
      };
    } catch (e) {
      this.fail(req, e);
    }
  }

  private invalidateSchema(db: ResolvedDatabase): void {
    for (const key of this.schemaCache.keys())
      if (key.startsWith(JSON.stringify([db.key]).slice(0, -1))) this.schemaCache.delete(key);
  }

  close(keys?: string[]): void {
    this.pool.closeKeys(keys);
    for (const key of this.schemaCache.keys())
      if (!keys || keys.some((k) => key.startsWith(JSON.stringify([k]).slice(0, -1)))) this.schemaCache.delete(key);
  }

  dispose(): Promise<void> {
    return this.pool.dispose();
  }
}

const HASH_PAIRS = new Set(['HGETALL']);

/** A Redis reply like redis-cli prints it; masked values of masked keys and hash fields. */
export function formatRedis(
  command: string,
  args: string[],
  value: unknown,
  masking: readonly string[],
  maxBytes: number,
): string {
  const keyMasked = args[0] !== undefined && matchesAny(args[0], masking);
  const lines: string[] = [];
  let bytes = 0;
  let cut = false;
  const push = (line: string) => {
    if (bytes + line.length > maxBytes - 256) {
      cut = true;
      return;
    }
    bytes += line.length + 1;
    lines.push(line);
  };
  const render = (v: unknown, indent: string, maskedValue: boolean) => {
    if (Array.isArray(v)) {
      if (v.length === 0) push(`${indent}(empty array)`);
      v.forEach((item, i) => {
        if (cut) return;
        const maskThis =
          maskedValue || (HASH_PAIRS.has(command) && i % 2 === 1 && matchesAny(String(v[i - 1] as string), masking));
        if (Array.isArray(item)) {
          push(`${indent}${i + 1})`);
          render(item, `${indent}   `, maskThis);
        } else push(`${indent}${i + 1}) ${maskThis && item !== null ? MASK : formatValue(item)}`);
      });
    } else push(`${indent}${maskedValue && v !== null ? MASK : formatValue(v)}`);
  };
  const formatValue = (v: unknown) =>
    v === null ? '(nil)' : typeof v === 'number' ? `(integer) ${v}` : JSON.stringify(formatCell(v));
  render(value, '', keyMasked && command !== 'TTL' && command !== 'PTTL' && command !== 'TYPE' && command !== 'EXISTS');
  if (cut)
    lines.push(
      `… (cut at the ${Math.round(maxBytes / 1024)} KB result limit; use SCAN/HSCAN with COUNT or a narrower range)`,
    );
  return lines.join('\n');
}
