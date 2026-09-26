import { transformLitellm, LITELLM_URL } from './litellm';
import { resolveModelKey } from './normalize-model';
import {
  type ModelPrice,
  type PriceOverride,
  PriceOverridesSchema,
  type PricingTable,
  PricingTableSchema,
} from './types';

export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PER_MILLION = 1_000_000;

export interface PricingCache {
  table: PricingTable;
  etag?: string;
  fetchedAt: number;
}

export interface PricingServiceDeps {
  snapshot: PricingTable;
  readCache: () => Promise<PricingCache | null>;
  writeCache: (cache: PricingCache) => Promise<void>;
  fetch: (
    url: string,
    init: { headers: Record<string, string> },
  ) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
  now: () => number;
  warn: (message: string, error?: unknown) => void;
}

export type PriceSource = 'override' | 'cache' | 'snapshot';

export interface ResolvedPrice {
  key: string;
  price: ModelPrice;
  source: PriceSource;
}

function guessProvider(model: string): ModelPrice['provider'] {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  return 'openai';
}

/**
 * Pricing layers (docs/plan/08-usage-monitor.md §10.2): user overrides (USD per 1M tokens) > the daily refreshed
 * cache (when newer than the snapshot) > the build-time snapshot.
 */
export class PricingService {
  private cache: PricingCache | null = null;
  private overrides: Record<string, PriceOverride> = {};
  private listeners = new Set<() => void>();

  constructor(private readonly deps: PricingServiceDeps) {}

  /** The table in use: the cache when it is newer than the snapshot. */
  get table(): PricingTable {
    const cached = this.cache?.table;
    return cached && cached.generatedAt > this.deps.snapshot.generatedAt ? cached : this.deps.snapshot;
  }

  get tableSource(): 'cache' | 'snapshot' {
    return this.table === this.deps.snapshot ? 'snapshot' : 'cache';
  }

  /** Version stored with computed costs; changes whenever any layer changes (→ recompute recent costs). */
  get version(): string {
    const keys = Object.keys(this.overrides);
    if (keys.length === 0) return this.table.version;
    let hash = 0;
    for (const ch of JSON.stringify(this.overrides)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    return `${this.table.version}+o${(hash >>> 0).toString(16)}`;
  }

  get lastFetchedAt(): number | null {
    return this.cache?.fetchedAt ?? null;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  async load(): Promise<void> {
    try {
      const cache = await this.deps.readCache();
      if (cache && PricingTableSchema.safeParse(cache.table).success) this.cache = cache;
    } catch (e) {
      this.deps.warn('Reading the pricing cache failed', e);
    }
  }

  /** `usage.pricing.overrides` (invalid entries are ignored). */
  setOverrides(value: unknown): void {
    const parsed = PriceOverridesSchema.safeParse(value ?? {});
    const next: Record<string, PriceOverride> = {};
    if (parsed.success) for (const [k, v] of Object.entries(parsed.data)) next[k.trim().toLowerCase()] = v;
    else this.deps.warn('usage.pricing.overrides is invalid and was ignored');
    if (JSON.stringify(next) === JSON.stringify(this.overrides)) return;
    this.overrides = next;
    this.changed();
  }

  lookup(rawModel: string): ResolvedPrice | undefined {
    const models = this.table.models;
    const key = resolveModelKey(rawModel, (k) => k in this.overrides || k in models);
    if (!key) return undefined;
    const override = this.overrides[key];
    if (override) {
      const base = models[key];
      const price: ModelPrice = {
        ...(base ?? {}),
        provider: override.provider ?? base?.provider ?? guessProvider(key),
        input: override.input / PER_MILLION,
        output: override.output / PER_MILLION,
        ...(override.cacheRead !== undefined ? { cacheRead: override.cacheRead / PER_MILLION } : {}),
        ...(override.cacheWrite5m !== undefined ? { cacheWrite5m: override.cacheWrite5m / PER_MILLION } : {}),
        ...(override.cacheWrite1h !== undefined ? { cacheWrite1h: override.cacheWrite1h / PER_MILLION } : {}),
      };
      return { key, price, source: 'override' };
    }
    return { key, price: models[key]!, source: this.tableSource };
  }

  shouldRefresh(): boolean {
    return !this.cache || this.deps.now() - this.cache.fetchedAt >= REFRESH_INTERVAL_MS;
  }

  /** Downloads LiteLLM's table (conditional on the ETag); network errors keep the current table. */
  async refresh(): Promise<'updated' | 'unchanged' | 'failed'> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.cache?.etag) headers['if-none-match'] = this.cache.etag;
      const res = await this.deps.fetch(LITELLM_URL, { headers });
      if (res.status === 304 && this.cache) {
        this.cache = { ...this.cache, fetchedAt: this.deps.now() };
        await this.deps.writeCache(this.cache);
        return 'unchanged';
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const table = PricingTableSchema.parse(
        transformLitellm((await res.json()) as Record<string, unknown>, new Date(this.deps.now())),
      );
      const etag = res.headers.get('etag');
      const before = this.version;
      this.cache = { table, fetchedAt: this.deps.now(), ...(etag ? { etag } : {}) };
      await this.deps.writeCache(this.cache);
      if (this.version !== before) this.changed();
      return 'updated';
    } catch (e) {
      this.deps.warn('Refreshing prices failed', e);
      return 'failed';
    }
  }

  /** Known models with rates per 1M tokens for the Pricing tab. */
  list(): { model: string; source: PriceSource; perMillion: Omit<PriceOverride, 'provider'> }[] {
    const keys = new Set([...Object.keys(this.table.models), ...Object.keys(this.overrides)]);
    return [...keys].sort().map((model) => {
      const r = this.lookup(model)!;
      const m = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * PER_MILLION * 1e6) / 1e6);
      return {
        model,
        source: r.source,
        perMillion: {
          input: m(r.price.input)!,
          output: m(r.price.output)!,
          ...(r.price.cacheRead !== undefined ? { cacheRead: m(r.price.cacheRead)! } : {}),
          ...(r.price.cacheWrite5m !== undefined ? { cacheWrite5m: m(r.price.cacheWrite5m)! } : {}),
          ...(r.price.cacheWrite1h !== undefined ? { cacheWrite1h: m(r.price.cacheWrite1h)! } : {}),
        },
      };
    });
  }
}
