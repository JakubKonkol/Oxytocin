import type { Redis as RedisClient, RedisOptions } from 'ioredis';
import type { RedisDriver } from './driver';
import type { Target } from './target';
import { tlsOptions } from './tls';

const ID_SEGMENT = /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A key's pattern: segments that look like ids become `*` (`user:42:session` → `user:*:session`). */
export const keyPattern = (key: string): string =>
  key
    .split(/([:./_-])/)
    .map((part) => (ID_SEGMENT.test(part) ? '*' : part))
    .join('');

/** Redis, Valkey and compatible servers (`ioredis`). */
export async function createRedis(t: Target, o: { root: string; timeoutMs: number }): Promise<RedisDriver> {
  const { default: Redis } = await import('ioredis');
  const tls = t.url?.startsWith('rediss:')
    ? { rejectUnauthorized: t.tls.mode === 'verify' }
    : await tlsOptions(t, o.root);
  const options: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
    commandTimeout: o.timeoutMs,
    connectionName: 'Oxytocin',
    retryStrategy: (times) => (times > 3 ? null : 500 * times),
    ...(t.tls.mode === 'disable' || (!t.url?.startsWith('rediss:') && t.tls.mode === 'prefer')
      ? {}
      : tls
        ? { tls }
        : {}),
  };
  const db = Number(t.options['db'] ?? (t.database && /^\d+$/.test(t.database) ? t.database : 0));
  const client: RedisClient = t.url
    ? new Redis(t.url, options)
    : new Redis({
        ...options,
        host: t.host,
        port: t.port ?? 6379,
        ...(t.user ? { username: t.user } : {}),
        ...(t.password !== undefined ? { password: t.password } : {}),
        db,
      });
  client.on('error', () => undefined);
  let connected: Promise<void> | undefined;
  const ready = () => {
    connected ??= client.connect().catch((e: unknown) => {
      connected = undefined;
      client.disconnect();
      throw e;
    });
    return connected;
  };

  return {
    family: 'redis',
    async version() {
      await ready();
      const info = await client.info('server');
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
      const valkey = /valkey_version:([^\r\n]+)/.exec(info)?.[1];
      return valkey ? `Valkey ${valkey}` : `Redis ${version ?? '?'}`;
    },
    async call(command, args) {
      await ready();
      return client.call(command, ...args);
    },
    async schema() {
      await ready();
      const keyspace = await client.info('keyspace');
      const patterns = new Map<string, { count: number; sample: string }>();
      let cursor = '0';
      let scanned = 0;
      do {
        const [next, keys] = await client.scan(cursor, 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
          scanned++;
          const p = keyPattern(key);
          const entry = patterns.get(p) ?? { count: 0, sample: key };
          entry.count++;
          patterns.set(p, entry);
        }
      } while (cursor !== '0' && scanned < 1000);
      const lines = [keyspace.trim().replace(/\r/g, '') || '# Keyspace (empty)'];
      lines.push(`Key patterns (from ${scanned} scanned key${scanned === 1 ? '' : 's'}):`);
      const sorted = [...patterns].sort((a, b) => b[1].count - a[1].count).slice(0, 100);
      for (const [pattern, { count, sample }] of sorted) {
        const type = await client.type(sample).catch(() => '?');
        lines.push(`  ${pattern} — ${type}, ${count} key${count === 1 ? '' : 's'}`);
      }
      return lines.join('\n');
    },
    close() {
      client.disconnect();
      return Promise.resolve();
    },
  };
}
