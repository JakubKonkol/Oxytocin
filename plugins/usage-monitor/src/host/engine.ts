import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectAttribution, type ProjectRef } from './attribution';
import { acceptClaudeLine, claudeProjectDirs, parseClaudeLine } from './collectors/claude-jsonl';
import {
  acceptCodexLine,
  codexDedupeKey,
  codexRoots,
  isCodexRollout,
  parseCodexLine,
} from './collectors/codex-rollout';
import {
  acceptGeminiLine,
  geminiRoots,
  isGeminiChat,
  parseGeminiDocument,
  parseGeminiLine,
} from './collectors/gemini-chats';
import { FileCollector } from './collectors/file-collector';
import { CursorStore } from './collectors/tail';
import { type AgentLimitRecord, type CollectedItem, isLimit, type UsageSource } from './model';
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

/** An agent running in an Oxytocin terminal (from `oxy.agents`). */
export interface AgentRef {
  terminalId: string;
  agentId: string;
  projectId: string;
  since: number;
  sessionId?: string;
  cwd?: string;
}

/** Codex/Gemini sessions are linked to a terminal when they start within this window of the agent (§6). */
const CORRELATION_BEFORE_MS = 5_000;
const CORRELATION_AFTER_MS = 60_000;
const CORRELATED_AGENTS = ['codex', 'gemini-cli'];

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
  private readonly linkListeners = new Set<(link: { terminalId: string; sessionId: string; agent: string }) => void>();
  private agents: AgentRef[] = [];
  private readonly linkedTerminals = new Set<string>();

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
      projectFor: (cwd, hash) => this.attribution.projectFor(cwd) ?? this.attribution.projectForHash(hash),
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
  ingest(items: CollectedItem[], cursor?: Parameters<CursorStore['set']>[0]): number {
    const ctx = this.context();
    let changed = 0;
    let correlate = false;
    transaction(this.db, () => {
      for (const item of items) {
        if (isLimit(item)) {
          if (this.writeLimit(item)) changed++;
          continue;
        }
        if (this.writer.write(item, ctx)) {
          changed++;
          if (CORRELATED_AGENTS.includes(item.agent)) correlate = true;
        }
      }
      if (cursor) this.cursors.set(cursor);
    });
    if (correlate) this.correlate();
    if (changed > 0) this.emitChanged(changed);
    return changed;
  }

  private writeLimit(l: AgentLimitRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO agent_limits (agent, window, used_percent, window_minutes, resets_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent, window) DO UPDATE SET used_percent = excluded.used_percent,
           window_minutes = excluded.window_minutes, resets_at = excluded.resets_at, observed_at = excluded.observed_at
         WHERE excluded.observed_at > agent_limits.observed_at`,
      )
      .run(l.agent, l.window, l.usedPercent, l.windowMinutes, l.resetsAt, l.observedAt);
    return Number(result.changes) > 0;
  }

  onSessionLinked(listener: (link: { terminalId: string; sessionId: string; agent: string }) => void): () => void {
    this.linkListeners.add(listener);
    return () => this.linkListeners.delete(listener);
  }

  /** Agents in Oxytocin terminals: session ids known to the core + correlation of Codex/Gemini sessions. */
  setAgents(list: AgentRef[]): void {
    this.agents = list;
    this.setAgentSessions(
      list.filter((a) => a.sessionId).map((a) => ({ sessionId: a.sessionId!, terminalId: a.terminalId })),
    );
    this.correlate();
  }

  /**
   * Links a new Codex/Gemini session to the terminal whose agent of the same kind started within 60 s in the same
   * project (§6); ambiguous matches (two candidates either way) stay unlinked.
   */
  private correlate(): void {
    const pending = this.agents.filter(
      (a) => CORRELATED_AGENTS.includes(a.agentId) && !a.sessionId && !this.linkedTerminals.has(a.terminalId),
    );
    if (pending.length === 0) return;
    const since = Math.min(...pending.map((a) => a.since)) - CORRELATION_BEFORE_MS;
    const sessions = this.db
      .prepare(
        `SELECT session_id AS sessionId, agent, cwd, project_id AS projectId, started_at AS startedAt FROM sessions
          WHERE terminal_id IS NULL AND agent IN ('codex', 'gemini-cli') AND started_at >= ?`,
      )
      .all(since) as unknown as {
      sessionId: string;
      agent: string;
      cwd: string | null;
      projectId: string | null;
      startedAt: number;
    }[];
    const matches = (a: AgentRef, s: (typeof sessions)[number]) =>
      s.agent === a.agentId &&
      s.startedAt >= a.since - CORRELATION_BEFORE_MS &&
      s.startedAt <= a.since + CORRELATION_AFTER_MS &&
      (s.projectId === a.projectId || (!!a.cwd && !!s.cwd && a.cwd === s.cwd));
    for (const agent of pending) {
      const candidates = sessions.filter((s) => matches(agent, s));
      if (candidates.length !== 1) continue;
      const session = candidates[0]!;
      if (pending.filter((a) => matches(a, session)).length !== 1) continue;
      this.linkedTerminals.add(agent.terminalId);
      this.setAgentSessions([{ sessionId: session.sessionId, terminalId: agent.terminalId }], true);
      for (const l of [...this.linkListeners])
        l({ terminalId: agent.terminalId, sessionId: session.sessionId, agent: agent.agentId });
    }
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
    const hashes = this.db
      .prepare('SELECT DISTINCT project_hash AS hash FROM usage_events WHERE cwd IS NULL AND project_hash IS NOT NULL')
      .all() as { hash: string }[];
    const events = this.db.prepare('UPDATE usage_events SET project_id = ? WHERE cwd = ?');
    const sessions = this.db.prepare('UPDATE sessions SET project_id = ? WHERE cwd = ?');
    const hashEvents = this.db.prepare('UPDATE usage_events SET project_id = ? WHERE cwd IS NULL AND project_hash = ?');
    const hashSessions = this.db.prepare('UPDATE sessions SET project_id = ? WHERE cwd IS NULL AND project_hash = ?');
    transaction(this.db, () => {
      for (const { cwd } of cwds) {
        const id = this.attribution.projectFor(cwd);
        events.run(id, cwd);
        sessions.run(id, cwd);
      }
      for (const { hash } of hashes) {
        const id = this.attribution.projectForHash(hash);
        hashEvents.run(id, hash);
        hashSessions.run(id, hash);
      }
    });
    this.emitChanged(1);
  }

  /** Agent sessions running in Oxytocin terminals (from `oxy.agents`): link sessions and recent events. */
  setAgentSessions(list: AgentSessionRef[], wholeSession = false): void {
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
        setEvents.run(terminalId, sessionId, wholeSession ? 0 : this.now() - DAY_MS);
        changed = true;
      }
    });
    if (changed) this.emitChanged(1);
  }

  /** Starts the enabled collectors (initial scan/backfill runs in the background). */
  startCollectors(options: {
    claudeCode?: boolean;
    claudeExtraDirs?: string[];
    codex?: boolean;
    gemini?: boolean;
    backfillDays?: number;
  }): Promise<void> {
    const env = this.opts.env ?? process.env;
    const deps = {
      getCursor: (path: string) => this.cursors.get(path),
      commit: (items: CollectedItem[], cursor: Parameters<CursorStore['set']>[0]) => {
        this.ingest(items, cursor);
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
    if (options.codex !== false && !this.collectors.has('codex-rollout')) {
      const collector = new FileCollector(
        {
          source: 'codex-rollout',
          roots: () => codexRoots(env, this.opts.home),
          match: isCodexRollout,
          accept: acceptCodexLine,
          parse: (line, path, state) => parseCodexLine(line, state, path),
          dedupeKey: codexDedupeKey,
        },
        deps,
      );
      this.collectors.set('codex-rollout', collector);
      started.push(collector.start());
    }
    if (options.gemini !== false && !this.collectors.has('gemini-chat')) {
      const collector = new FileCollector(
        {
          source: 'gemini-chat',
          roots: () => geminiRoots(env, this.opts.home),
          match: isGeminiChat,
          accept: acceptGeminiLine,
          parse: (line, path, state) => parseGeminiLine(line, state, path),
          isWhole: (path) => path.endsWith('.json'),
          parseWhole: (text, path) => parseGeminiDocument(text, path),
        },
        deps,
      );
      this.collectors.set('gemini-chat', collector);
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
