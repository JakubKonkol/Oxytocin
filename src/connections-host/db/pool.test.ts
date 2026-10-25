import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseResourceSchema } from '@shared/domain/project-resources';
import type { ResolvedDatabase } from '@shared/rpc/contracts/connections-host';
import type { SqlDriver } from './driver';
import { DriverPool } from './pool';
import { createSqlite } from './sqlite';
import { resolveTarget, type Target } from './target';

vi.mock('./sqlite', () => ({ createSqlite: vi.fn() }));
vi.mock('./target', () => ({ resolveTarget: vi.fn() }));

afterEach(() => vi.resetAllMocks());

const db: ResolvedDatabase = {
  key: 'project/db',
  fingerprint: 'v1',
  projectRoot: '.',
  secrets: {},
  resource: DatabaseResourceSchema.parse({
    id: 'db',
    name: 'db',
    engine: 'sqlite',
    connection: { kind: 'file', path: 'test.db' },
  }),
};
const driver = () =>
  ({
    family: 'sql',
    version: vi.fn(),
    query: vi.fn(),
    schema: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }) satisfies SqlDriver;
const target: Target = {
  engine: 'sqlite',
  host: '',
  options: {},
  secrets: [],
  tls: { mode: 'disable', trustServerCertificate: false },
};

describe('DriverPool', () => {
  it('keeps a replacement pool when the dropped connection fails later', async () => {
    const old = Promise.withResolvers<Target>();
    const current = driver();
    vi.mocked(resolveTarget).mockReturnValueOnce(old.promise).mockResolvedValueOnce(target);
    vi.mocked(createSqlite).mockReturnValue(current);
    const pool = new DriverPool();
    try {
      const first = pool.get(db);
      expect(resolveTarget).toHaveBeenCalledTimes(1);
      pool.drop(db);
      const replacement = pool.get(db);
      await expect(replacement).resolves.toMatchObject({ driver: current });
      const failed = expect(first).rejects.toThrow('old connection failed');
      old.reject(new Error('old connection failed'));
      await failed;
      expect(pool.get(db)).toBe(replacement);
      expect(resolveTarget).toHaveBeenCalledTimes(2);
      expect(createSqlite).toHaveBeenCalledOnce();
    } finally {
      await pool.dispose();
    }
    expect(current.close).toHaveBeenCalledOnce();
  });

  it('closes a pending driver on shutdown and rejects later requests', async () => {
    const pending = Promise.withResolvers<Target>();
    const opened = driver();
    vi.mocked(resolveTarget).mockReturnValueOnce(pending.promise);
    vi.mocked(createSqlite).mockReturnValue(opened);
    const pool = new DriverPool();
    const getting = pool.get(db);
    const closing = pool.dispose();
    pending.resolve(target);
    await getting;
    await closing;
    expect(opened.close).toHaveBeenCalledOnce();
    await expect(pool.get(db)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(createSqlite).toHaveBeenCalledOnce();
  });
});
