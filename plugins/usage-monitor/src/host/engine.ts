import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import snapshot from './pricing/snapshot.json';
import { PricingService, type PricingCache, type PricingServiceDeps } from './pricing/pricing-service';
import type { PricingTable } from './pricing/types';
import { DEFAULT_SETTINGS, type UsageSettings } from './settings';
import { type Database, getMeta, openDatabase, schemaVersion, setMeta } from './store/db';

export interface EngineOptions {
  /** SQLite file (`:memory:` in tests). */
  dbPath: string;
  /** Plugin storage folder (pricing cache). */
  storageDir: string;
  fetch?: PricingServiceDeps['fetch'];
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
}

const PRICING_CACHE = 'pricing-cache.json';

/**
 * Everything that runs in the ingest worker (docs/plan/08-usage-monitor.md §2): the database, pricing and — from
 * M6-T3 on — collectors and aggregations. Kept free of worker APIs so tests drive it directly.
 */
export class UsageEngine {
  readonly db: Database;
  readonly pricing: PricingService;
  settings: UsageSettings = DEFAULT_SETTINGS;
  private readonly now: () => number;

  private constructor(opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.db = openDatabase(opts.dbPath);
    const cachePath = join(opts.storageDir, PRICING_CACHE);
    this.pricing = new PricingService({
      snapshot: snapshot as PricingTable,
      readCache: async () => {
        try {
          return JSON.parse(await readFile(cachePath, 'utf8')) as PricingCache;
        } catch {
          return null;
        }
      },
      writeCache: async (cache) => {
        await mkdir(opts.storageDir, { recursive: true });
        await writeFile(`${cachePath}.tmp`, JSON.stringify(cache));
        await rename(`${cachePath}.tmp`, cachePath);
      },
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      now: this.now,
      warn: opts.warn ?? (() => undefined),
    });
  }

  static async create(opts: EngineOptions): Promise<UsageEngine> {
    const engine = new UsageEngine(opts);
    await engine.pricing.load();
    engine.recordPricingVersion();
    return engine;
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  /** Stores the pricing version in use; a change means computed costs need recomputing (M6-T3). */
  private recordPricingVersion(): boolean {
    const version = this.pricing.version;
    if (getMeta(this.db, 'pricing_version') === version) return false;
    setMeta(this.db, 'pricing_version', version);
    return true;
  }

  setSettings(settings: Partial<UsageSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.pricing.setOverrides(this.settings.pricingOverrides);
    this.recordPricingVersion();
  }

  /** Daily refresh when enabled (called periodically by the worker). */
  async maybeRefreshPricing(force = false): Promise<'updated' | 'unchanged' | 'failed' | 'skipped'> {
    if (!force && (!this.settings.pricingAutoUpdate || !this.pricing.shouldRefresh())) return 'skipped';
    const result = await this.pricing.refresh();
    this.recordPricingVersion();
    return result;
  }

  close(): void {
    this.db.close();
  }
}
