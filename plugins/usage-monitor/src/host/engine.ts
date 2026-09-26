import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectAttribution, type ProjectRef } from './attribution';
import { acceptClaudeLine, claudeProjectDirs, parseClaudeLine } from './collectors/claude-jsonl';
import { FileCollector } from './collectors/file-collector';
import { CursorStore } from './collectors/tail';
import type { UsageRecord, UsageSource } from './model';
import snapshot from './pricing/snapshot.json';
import { PricingService, type PricingCache, type PricingServiceDeps } from './pricing/pricing-service';
import type { PricingTable } from './pricing/types';
import { DEFAULT_SETTINGS, type UsageSettings } from './settings';
import { type Database, getMeta, openDatabase, schemaVersion, setMeta, transaction } from './store/db';
import { EventWriter, type IngestContext, recomputeCosts } from './store/events';

export interface EngineOptions {
  /** SQLite file (`:memory:` in tests). */
  dbPath: string;
  /** Plugin storage folder (pricing cache). */
  storageDir: string;
  fetch?: PricingServiceDeps['fetch'];
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
  /** Environment used to find the agents' folders (tests pass fixture paths). */
  env?: NodeJS.ProcessEnv;
  home?: string;
  caseInsensitivePaths?: boolean;
}

export interface AgentSessionRef {
  sessionId: string;
  terminalId: string;
}

const PRICING_CACHE = 'pricing-cache.json';
const RECOMPUTE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything that runs in the ingest worker (docs/plan/08-usage-monitor.md §2): the database, pricing, collectors
 * and attribution. Kept free of worker APIs so tests drive it directly.
 */
export class UsageEngine {
  readonly db: Database;
  readonly pricing: PricingService;
  settings: UsageSettings = DEFAULT_SETTINGS;
  readonly attribution: ProjectAttribution;
  readonly collectors = new Map<UsageSource, FileCollector>();
  private readonly now: () => number;
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly writer: EventWriter;
  private readonly cursors: CursorStore;
  private readonly terminals = new Map<string, string>();
  private readonly changeListeners = new Set<(count: number) => void>();
  private readonly progressListeners = new Set<(source: UsageSource, done: number, total: number) => void>();

  private constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? (() => undefined);
    this.db = openDatabase(opts.dbPath);
    this.writer = new EventWriter(this.db);
    this.cursors = new CursorStore(this.db);
    this.attribution = new ProjectAttribution(opts.caseInsensitivePaths);
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
      warn: this.warn,
    });
  }

  static async create(opts: EngineOptions): Promise<UsageEngine> {
    const engine = new UsageEngine(opts);
    await engine.pricing.load();
    engine.syncCosts();
    return engine;
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  onDidChange(listener: (count: number) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onProgress(listener: (source: UsageSource, done: number, total: number) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private context(): IngestContext {
    return {
      costMode: this.settings.costMode,
      pricingVersion: this.pricing.version,
      lookup: (model) => this.pricing.lookup(model),
      projectFor: (cwd) => this.attribution.projectFor(cwd),
      terminalFor: (sessionId) => (sessionId ? (this.terminals.get(sessionId) ?? null) : null),
    };
  }

  /** Pricing version or cost mode changed → recompute the costs of the last 90 days (§10.2). */
  private syncCosts(): void {
    const key = `${this.pricing.version}|${this.settings.costMode}`;
    if (getMeta(this.db, 'cost_basis') === key) return;
    transaction(this.db, () => {
      recomputeCosts(this.db, this.context(), this.now() - RECOMPUTE_DAYS * DAY_MS);
      setMeta(this.db, 'cost_basis', key);
      setMeta(this.db, 'pricing_version', this.pricing.version);
    });
    this.emitChanged(1);
  }

  setSettings(settings: Partial<UsageSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.pricing.setOverrides(this.settings.pricingOverrides);
    this.syncCosts();
  }

  /** Daily refresh when enabled (called periodically by the worker). */
  async maybeRefreshPricing(force = false): Promise<'updated' | 'unchanged' | 'failed' | 'skipped'> {
    if (!force && (!this.settings.pricingAutoUpdate || !this.pricing.shouldRefresh())) return 'skipped';
    const result = await this.pricing.refresh();
    this.syncCosts();
    return result;
  }

  /** Writes collector output + cursor atomically. */
  ingest(records: UsageRecord[], cursor?: Parameters<CursorStore['set']>[0]): number {
    const ctx = this.context();
    let changed = 0;
    transaction(this.db, () => {
      for (const r of records) if (this.writer.write(r, ctx)) changed++;
      if (cursor) this.cursors.set(cursor);
    });
    if (changed > 0) this.emitChanged(changed);
    return changed;
  }

  private emitChanged(count: number): void {
    for (const l of [...this.changeListeners]) l(count);
  }

  /** Oxytocin projects changed: re-attribute events by their cwd. */
  setProjects(projects: ProjectRef[]): void {
    if (!this.attribution.setProjects(projects)) return;
    const cwds = this.db.prepare('SELECT DISTINCT cwd FROM usage_events WHERE cwd IS NOT NULL').all() as {
      cwd: string;
    }[];
    const events = this.db.prepare('UPDATE usage_events SET project_id = ? WHERE cwd = ?');
    const sessions = this.db.prepare('UPDATE sessions SET project_id = ? WHERE cwd = ?');
    transaction(this.db, () => {
      for (const { cwd } of cwds) {
        const id = this.attribution.projectFor(cwd);
        events.run(id, cwd);
        sessions.run(id, cwd);
      }
    });
    this.emitChanged(1);
  }

  /** Agent sessions running in Oxytocin terminals (from `oxy.agents`): link sessions and recent events. */
  setAgentSessions(list: AgentSessionRef[]): void {
    const setSession = this.db.prepare('UPDATE sessions SET terminal_id = ? WHERE session_id = ?');
    const setEvents = this.db.prepare(
      'UPDATE usage_events SET terminal_id = ? WHERE session_id = ? AND terminal_id IS NULL AND ts >= ?',
    );
    let changed = false;
    transaction(this.db, () => {
      for (const { sessionId, terminalId } of list) {
        if (this.terminals.get(sessionId) === terminalId) continue;
        this.terminals.set(sessionId, terminalId);
        setSession.run(terminalId, sessionId);
        setEvents.run(terminalId, sessionId, this.now() - DAY_MS);
        changed = true;
      }
    });
    if (changed) this.emitChanged(1);
  }

  /** Starts the enabled collectors (initial scan/backfill runs in the background). */
  startCollectors(options: { claudeCode?: boolean; claudeExtraDirs?: string[]; backfillDays?: number }): Promise<void> {
    const env = this.opts.env ?? process.env;
    const deps = {
      getCursor: (path: string) => this.cursors.get(path),
      commit: (records: UsageRecord[], cursor: Parameters<CursorStore['set']>[0]) => {
        this.ingest(records, cursor);
      },
      readText: (path: string) => readFile(path, 'utf8'),
      now: this.now,
      backfillDays: () => options.backfillDays ?? 30,
      warn: this.warn,
      progress: (source: UsageSource, done: number, total: number) => {
        for (const l of [...this.progressListeners]) l(source, done, total);
      },
    };
    const started: Promise<void>[] = [];
    if (options.claudeCode !== false && !this.collectors.has('claude-jsonl')) {
      const collector = new FileCollector(
        {
          source: 'claude-jsonl',
          roots: () => claudeProjectDirs(env, options.claudeExtraDirs ?? [], this.opts.home),
          match: (p) => p.endsWith('.jsonl'),
          accept: acceptClaudeLine,
          parse: (line, path) => {
            const r = parseClaudeLine(line, path);
            return r ? [r] : [];
          },
        },
        deps,
      );
      this.collectors.set('claude-jsonl', collector);
      started.push(collector.start());
    }
    return Promise.all(started).then(() => undefined);
  }

  stopCollectors(): void {
    for (const c of this.collectors.values()) c.stop();
    this.collectors.clear();
  }

  close(): void {
    this.stopCollectors();
    this.db.close();
  }
}
