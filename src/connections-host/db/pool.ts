import type { ResolvedDatabase } from '@shared/rpc/contracts/connections-host';
import type { Driver } from './driver';
import { resolveTarget, type Target } from './target';

const IDLE_MS = 5 * 60_000;
const SWEEP_MS = 60_000;

/** Creates the driver of an engine (drivers are imported on first use, so start-up does not load them). */
export async function createDriver(db: ResolvedDatabase, target: Target): Promise<Driver> {
  const root = db.projectRoot;
  const timeoutMs = db.resource.access.timeoutMs;
  switch (db.resource.engine) {
    case 'postgresql':
    case 'cockroachdb':
      return (await import('./postgres')).createPostgres(target, {
        root,
        readOnly: db.resource.access.mode === 'read-only',
      });
    case 'mysql':
    case 'mariadb':
      return (await import('./mysql')).createMysql(target, { root });
    case 'sqlserver':
      return (await import('./sqlserver')).createSqlServer(target, { timeoutMs });
    case 'sqlite':
      return (await import('./sqlite')).createSqlite(target);
    case 'clickhouse':
      return (await import('./clickhouse')).createClickHouse(target, { root, timeoutMs });
    case 'oracle':
      return (await import('./oracle')).createOracle(target);
    case 'mongodb':
      return (await import('./mongo')).createMongo(target, { root });
    case 'redis':
      return (await import('./redis')).createRedis(target, { root, timeoutMs });
  }
}

interface Entry {
  key: string;
  driver: Promise<{ driver: Driver; target: Target }>;
  lastUsed: number;
}

/**
 * Open drivers (connection pools) per resource configuration: at most two connections each, closed after 5 minutes
 * without use, when the resource changes or is removed, and when the host shuts down.
 */
export class DriverPool {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  get(db: ResolvedDatabase): Promise<{ driver: Driver; target: Target }> {
    const id = `${db.key}#${db.fingerprint}`;
    let entry = this.entries.get(id);
    if (!entry) {
      // A new configuration of the same resource replaces the old pool.
      for (const [other, e] of this.entries) if (e.key === db.key) this.close(other, e);
      const driver = resolveTarget(db).then(async (target) => ({ driver: await createDriver(db, target), target }));
      entry = { key: db.key, driver, lastUsed: this.now() };
      this.entries.set(id, entry);
      driver.catch(() => this.entries.delete(id));
    }
    entry.lastUsed = this.now();
    return entry.driver;
  }

  /** Drops a pool after a connection error, so the next call connects again. */
  drop(db: ResolvedDatabase): void {
    const id = `${db.key}#${db.fingerprint}`;
    const entry = this.entries.get(id);
    if (entry) this.close(id, entry);
  }

  private close(id: string, entry: Entry): void {
    this.entries.delete(id);
    void entry.driver.then(({ driver }) => driver.close()).catch(() => undefined);
  }

  /** Closes the pools of these resource keys (all when omitted). */
  closeKeys(keys?: string[]): void {
    for (const [id, entry] of this.entries) if (!keys || keys.includes(entry.key)) this.close(id, entry);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now - entry.lastUsed > IDLE_MS) this.close(id, entry);
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.driver.then(({ driver }) => driver.close()).catch(() => undefined)));
  }
}
