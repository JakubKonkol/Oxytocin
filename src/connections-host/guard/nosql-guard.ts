import type { AccessMode } from '@shared/domain/project-resources';
import type { Classification } from '@shared/rpc/contracts/connections-host';

// ── MongoDB ──

export const MONGO_READS = [
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'listIndexes',
  'collStats',
] as const;
export const MONGO_WRITES = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;
export const MONGO_OPERATIONS: readonly string[] = [...MONGO_READS, ...MONGO_WRITES];

/** Stages and operators that write, run JavaScript on the server or read other databases. */
const MONGO_FORBIDDEN: Record<string, string> = {
  $out: '$out writes a collection',
  $merge: '$merge writes a collection',
  $function: '$function runs JavaScript on the server',
  $accumulator: '$accumulator runs JavaScript on the server',
  $where: '$where runs JavaScript on the server',
};

/** Every forbidden key anywhere in a value (nested pipelines of $lookup, $facet and $unionWith included). */
export function forbiddenMongoKeys(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 100) {
    found.add('$too-deep');
    return found;
  }
  if (Array.isArray(value)) for (const item of value) forbiddenMongoKeys(item, found, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key in MONGO_FORBIDDEN) found.add(key);
      forbiddenMongoKeys(inner, found, depth + 1);
    }
  }
  return found;
}

const isEmptyFilter = (filter: unknown) =>
  filter === undefined ||
  filter === null ||
  (typeof filter === 'object' && !Array.isArray(filter) && Object.keys(filter).length === 0);

/** Classifies a MongoDB operation of `oxy_mongo`. */
export function classifyMongo(collection: string, operation: string, args: Record<string, unknown>): Classification {
  const c: Classification = {
    kind: (MONGO_READS as readonly string[]).includes(operation)
      ? 'read'
      : (MONGO_WRITES as readonly string[]).includes(operation)
        ? 'write'
        : 'unknown',
    statement: operation,
    tables: collection ? [collection] : [],
    reasons: [],
    dangerous: [],
  };
  if (c.kind === 'unknown') {
    c.reasons.push(
      `${operation} is not offered. Operations: ${MONGO_OPERATIONS.join(', ')} (drop and dropDatabase never are).`,
    );
    return c;
  }
  if (c.kind === 'write') c.reasons.push(`${operation} writes`);
  for (const key of forbiddenMongoKeys(args)) {
    const reason = MONGO_FORBIDDEN[key] ?? 'the arguments are nested too deeply';
    c.reasons.push(reason);
    c.dangerous.push(reason);
    if (key !== '$where' && key !== '$function' && key !== '$accumulator') c.kind = 'write';
  }
  if ((operation === 'deleteMany' || operation === 'updateMany') && isEmptyFilter(args['filter']))
    c.dangerous.push(`${operation} with an empty filter changes every document`);
  return c;
}

// ── Redis ──

/** Read-only commands (KEYS is replaced by SCAN: it blocks the server on large databases). */
export const REDIS_READS = new Set(
  `GET MGET STRLEN GETRANGE EXISTS TYPE TTL PTTL EXPIRETIME HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN
   LRANGE LLEN LINDEX LPOS SMEMBERS SCARD SISMEMBER SMISMEMBER SRANDMEMBER ZRANGE ZRANGEBYSCORE ZRANGEBYLEX
   ZREVRANGE ZREVRANGEBYSCORE ZCARD ZSCORE ZMSCORE ZRANK ZREVRANK ZCOUNT ZLEXCOUNT SCAN HSCAN SSCAN ZSCAN XRANGE
   XREVRANGE XLEN XINFO INFO DBSIZE PING TIME MEMORY OBJECT BITCOUNT GETBIT PFCOUNT GEOPOS GEODIST GEOSEARCH
   GEOHASH JSON.GET JSON.TYPE JSON.OBJKEYS JSON.OBJLEN JSON.ARRLEN JSON.STRLEN`
    .split(/\s+/)
    .filter(Boolean),
);

/** Subcommands of read commands that are reads. */
const REDIS_READ_SUBCOMMANDS: Record<string, Set<string>> = {
  MEMORY: new Set(['USAGE', 'STATS', 'DOCTOR']),
  OBJECT: new Set(['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT']),
  XINFO: new Set(['STREAM', 'GROUPS', 'CONSUMERS']),
};

/** Never offered, in any mode. */
export const REDIS_NEVER = new Set(
  `EVAL EVALSHA EVAL_RO EVALSHA_RO FCALL FCALL_RO FUNCTION SCRIPT CONFIG FLUSHALL FLUSHDB SHUTDOWN DEBUG MODULE
   MONITOR SYNC PSYNC REPLICAOF SLAVEOF CLUSTER FAILOVER ACL CLIENT SAVE BGSAVE BGREWRITEAOF MIGRATE RESTORE
   SUBSCRIBE PSUBSCRIBE SSUBSCRIBE SELECT SWAPDB MULTI EXEC WATCH AUTH HELLO QUIT RESET LATENCY SLOWLOG
   KEYS WAIT WAITAOF BLPOP BRPOP BLMOVE BZPOPMIN BZPOPMAX BLMPOP BZMPOP XREAD XREADGROUP OBJECT`
    .split(/\s+/)
    .filter(Boolean),
);

const REDIS_DANGEROUS = new Set(['DEL', 'UNLINK', 'RENAME', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'GETDEL']);

/** Classifies a Redis command of `oxy_redis`. */
export function classifyRedis(command: string, args: string[]): Classification {
  const name = command.trim().toUpperCase();
  const sub = args[0]?.toUpperCase();
  const c: Classification = { kind: 'write', statement: name, tables: [], reasons: [], dangerous: [] };
  if (name === 'KEYS') {
    c.kind = 'unknown';
    c.reasons.push('KEYS blocks the server on large databases; use SCAN with MATCH and COUNT instead.');
    return c;
  }
  const subOk = REDIS_READ_SUBCOMMANDS[name];
  if (subOk ? sub !== undefined && subOk.has(sub) : REDIS_READS.has(name)) {
    c.kind = 'read';
    return c;
  }
  if (REDIS_NEVER.has(name) || !/^[A-Z][A-Z0-9._]*$/.test(name)) {
    c.kind = 'unknown';
    c.reasons.push(`${name || 'This command'} is not offered through the bridge.`);
    return c;
  }
  c.reasons.push(`${name} is not a read-only command`);
  if (REDIS_DANGEROUS.has(name)) c.dangerous.push(`${name} removes or expires keys`);
  return c;
}

/** The same decision rules as SQL (see `decide` in sql-guard). */
export function decideNoSql(
  mode: AccessMode,
  c: Classification,
  name: string,
): { action: 'run-read' | 'run-write' | 'ask' | 'reject'; message: string } {
  const why = c.reasons.length ? ` (${c.reasons.join('; ')})` : '';
  if (c.kind === 'unknown') return { action: 'reject', message: `Refused: ${c.reasons.join(' ')}` };
  if (c.kind === 'read' && c.reasons.length === 0) return { action: 'run-read', message: '' };
  if (mode === 'read-only')
    return {
      action: 'reject',
      message: `Refused: "${name}" is read-only for agents${why}. Ask the user to change its access mode in Project settings → Databases if a write is needed.`,
    };
  if (mode === 'confirm-writes' || c.dangerous.length)
    return { action: 'ask', message: `${c.statement} on "${name}" needs the user's approval${why}.` };
  return { action: 'run-write', message: '' };
}
