import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectAttribution, type ProjectRef } from './attribution';
import { acceptClaudeLine, claudeProjectDirs, parseClaudeLine } from './collectors/claude-jsonl';
import { ClaudeStatusLineReader } from './collectors/claude-statusline';
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
import { CumulativeTracker, parseOtlpMetrics, type OtlpSessionInfo } from './collectors/otlp';
import { OtlpServer } from './collectors/otlp-server';
import { CursorStore } from './collectors/tail';
import { type AgentLimitRecord, type CollectedItem, isLimit, type UsageRecord, type UsageSource } from './model';
import snapshot from './pricing/snapshot.json';
import { PricingService, type PricingCache, type PricingServiceDeps } from './pricing/pricing-service';
import type { PricingTable } from './pricing/types';
import { DEFAULT_SETTINGS, type UsageSettings } from './settings';
import {
  type BudgetAlert,
  type BudgetInput,
  checkBudgetAlerts,
  deleteBudget,
  evaluateBudget,
  listBudgets,
  saveBudget,
} from './analytics/budgets';
import { sidebarModel, statusModel, type ViewContext } from './analytics/view-model';
import { addDays, startOfDay } from './analytics/periods';
import {
  breakdown,
  burnRate,
  sessionById,
  sessionEvents,
  sessions,
  type SessionSort,
  summary,
  timeseries,
  unknownModels,
} from './analytics/queries';
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
  state?: string;
}

/** Codex/Gemini sessions are linked to a terminal when they start within this window of the agent (§6). */
const CORRELATION_BEFORE_MS = 5_000;
const CORRELATION_AFTER_MS = 60_000;
const CORRELATED_AGENTS = ['codex', 'gemini-cli'];

/** One source per session (§9.4): OTLP data waits this long for the session's log file before it counts. */
export const OTLP_PRIMARY_WAIT_MS = 15_000;
const FILE_SOURCE: Record<string, UsageSource> = { 'claude-code': 'claude-jsonl', 'gemini-cli': 'gemini-chat' };

/** Variables that mean the user configured OpenTelemetry for Claude Code themselves (§9.3). */
const USER_OTEL_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
];

/** Whether the environment or Claude Code's settings.json already configure OpenTelemetry. */
export function detectUserOtelConfig(env: NodeJS.ProcessEnv, home: string = homedir()): string | null {
  const inEnv = USER_OTEL_VARS.find((v) => env[v]);
  if (inEnv) return `${inEnv} is set in the environment`;
  const dirs = [...(env['CLAUDE_CONFIG_DIR'] ?? '').split(','), join(home, '.claude')]
    .map((d) => d.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    const file = join(dir, 'settings.json');
    if (!existsSync(file)) continue;
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> };
      const found = USER_OTEL_VARS.find((v) => settings.env?.[v] !== undefined);
      if (found) return `${found} is set in ${file}`;
    } catch {
      // Unreadable settings: ignore.
    }
  }
  return null;
}

export interface OtlpEndpoint {
  port: number;
  token: string;
}

const PRICING_CACHE = 'pricing-cache.json';
const RECOMPUTE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything that runs in the ingest worker: the database, pricing, collectors
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
  activeProjectId: string | null = null;
  private readonly linkedTerminals = new Set<string>();
  private otlp: OtlpServer | undefined;
  private readonly otlpTracker = new CumulativeTracker();
  private readonly primary = new Map<string, string>();
  private readonly pendingOtel = new Map<string, { records: UsageRecord[]; since: number }>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private statusLine: ClaudeStatusLineReader | undefined;

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
        if (!this.admitFileRecord(item)) continue;
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

  private primarySource(sessionId: string): string | null {
    const cached = this.primary.get(sessionId);
    if (cached) return cached;
    const row = this.db.prepare('SELECT primary_source AS source FROM sessions WHERE session_id = ?').get(sessionId) as
      { source: string | null } | undefined;
    if (row?.source) this.primary.set(sessionId, row.source);
    return row?.source ?? null;
  }

  /** Log-file records of a session whose primary source became OTLP are dropped (no double counting). */
  private admitFileRecord(r: UsageRecord): boolean {
    const fileSource = FILE_SOURCE[r.agent];
    if (!r.sessionId || r.source !== fileSource) return true;
    const primary = this.primarySource(r.sessionId);
    if (primary && primary !== fileSource) return false;
    if (!primary) {
      this.primary.set(r.sessionId, fileSource);
      this.pendingOtel.delete(r.sessionId);
      this.db
        .prepare(
          `INSERT INTO sessions (session_id, agent, primary_source) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET primary_source = coalesce(sessions.primary_source, excluded.primary_source)`,
        )
        .run(r.sessionId, r.agent, fileSource);
    }
    return true;
  }

  /** An OTLP metrics export (§9.4). */
  ingestOtlp(body: unknown): void {
    const batch = parseOtlpMetrics(body, this.otlpTracker);
    transaction(this.db, () => {
      for (const s of batch.sessions) this.applyOtlpSession(s);
    });
    const now = this.now();
    const admitted: UsageRecord[] = [];
    for (const r of batch.records) {
      const primary = this.primarySource(r.sessionId!);
      if (primary === r.source) admitted.push(r);
      else if (!primary) {
        const pending = this.pendingOtel.get(r.sessionId!) ?? { records: [], since: now };
        pending.records.push(r);
        this.pendingOtel.set(r.sessionId!, pending);
      }
      // Primary is the log file: tokens come from there; the export only updated the session above.
    }
    if (admitted.length > 0) this.ingest(admitted);
    this.schedulePendingCheck();
    this.emitChanged(1);
  }

  private applyOtlpSession(s: OtlpSessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, agent, project_id, terminal_id, reported_cost_usd) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project_id = coalesce(sessions.project_id, excluded.project_id),
           terminal_id = coalesce(sessions.terminal_id, excluded.terminal_id),
           reported_cost_usd = coalesce(sessions.reported_cost_usd, 0) + excluded.reported_cost_usd`,
      )
      .run(s.sessionId, s.agent, s.projectId ?? null, s.terminalId ?? null, s.reportedCostUsd);
    if (s.terminalId && !this.terminals.has(s.sessionId)) {
      this.terminals.set(s.sessionId, s.terminalId);
      this.db
        .prepare('UPDATE usage_events SET terminal_id = ? WHERE session_id = ? AND terminal_id IS NULL')
        .run(s.terminalId, s.sessionId);
    }
  }

  /** OTLP data waiting for a log file: after 15 s without one, OTLP becomes the session's primary source. */
  flushPendingOtel(): void {
    const now = this.now();
    for (const [sessionId, pending] of [...this.pendingOtel]) {
      if (now - pending.since < OTLP_PRIMARY_WAIT_MS) continue;
      this.pendingOtel.delete(sessionId);
      if (this.primarySource(sessionId)) continue;
      const source = pending.records[0]!.source;
      this.primary.set(sessionId, source);
      this.db.prepare('UPDATE sessions SET primary_source = ? WHERE session_id = ?').run(source, sessionId);
      this.ingest(pending.records);
    }
    this.schedulePendingCheck();
  }

  private schedulePendingCheck(): void {
    clearTimeout(this.pendingTimer);
    if (this.pendingOtel.size === 0) return;
    const oldest = Math.min(...[...this.pendingOtel.values()].map((p) => p.since));
    this.pendingTimer = setTimeout(
      () => this.flushPendingOtel(),
      Math.max(0, oldest + OTLP_PRIMARY_WAIT_MS - this.now()) + 10,
    );
    this.pendingTimer.unref?.();
  }

  /** Starts or stops the local receiver; the endpoint (port + token) is kept in the database across restarts. */
  async configureOtlp(enabled: boolean): Promise<OtlpEndpoint | null> {
    if (!enabled) {
      await this.otlp?.stop();
      this.otlp = undefined;
      return null;
    }
    let token = getMeta(this.db, 'otlp_token');
    if (!token) {
      token = randomBytes(32).toString('hex');
      setMeta(this.db, 'otlp_token', token);
    }
    if (!this.otlp) {
      this.otlp = new OtlpServer(token, (body) => this.ingestOtlp(body), this.now);
      const port = await this.otlp.start(Number(getMeta(this.db, 'otlp_port') ?? 0));
      setMeta(this.db, 'otlp_port', String(port));
    }
    return { port: this.otlp.stats.port!, token };
  }

  /** Reads Claude subscription limits written by the status line script in `dir` (null stops reading). */
  async configureClaudeStatusLine(dir: string | null): Promise<void> {
    if (this.statusLine?.dir !== dir) {
      this.statusLine?.stop();
      this.statusLine = undefined;
      if (dir) {
        this.statusLine = new ClaudeStatusLineReader(dir, (items) => this.ingest(items), this.warn);
        await this.statusLine.start();
      }
    }
    // The views show whether the status line is set up.
    this.emitChanged(1);
  }

  /** When the Claude subscription limits were last reported (null: never). */
  claudeLimitsObservedAt(): number | null {
    const row = this.db.prepare("SELECT max(observed_at) AS at FROM agent_limits WHERE agent = 'claude-code'").get() as
      { at: number | null } | undefined;
    return row?.at ?? null;
  }

  get otlpStats() {
    return this.otlp?.stats ?? null;
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

  viewContext(): ViewContext {
    return {
      now: this.now(),
      activeProjectId: this.activeProjectId,
      agents: this.agents,
      billing: this.settings.billing,
      weekStartsOn: this.settings.weekStartsOn,
      claudeBlockLimit: this.settings.claudeBlockLimit,
      projectName: (id) => this.attribution.name(id),
    };
  }

  sidebar() {
    return sidebarModel(this.db, this.viewContext());
  }

  status() {
    return statusModel(this.db, this.viewContext());
  }

  budgets() {
    const now = this.now();
    return listBudgets(this.db).map((b) => evaluateBudget(this.db, b, now, this.settings.weekStartsOn));
  }

  saveBudget(input: BudgetInput) {
    const b = saveBudget(this.db, input, this.now());
    this.emitChanged(1);
    return b;
  }

  deleteBudget(id: string): void {
    deleteBudget(this.db, id);
    this.emitChanged(1);
  }

  /** Budget thresholds crossed for the first time in their period (§13) → notifications. */
  checkBudgets(): BudgetAlert[] {
    const now = this.now();
    const statuses = listBudgets(this.db)
      .filter((b) => b.enabled)
      .map((b) => evaluateBudget(this.db, b, now, this.settings.weekStartsOn));
    return checkBudgetAlerts(this.db, statuses, now);
  }

  /** Dashboard → Overview (§14.3). */
  overview() {
    const now = this.now();
    const today = startOfDay(now);
    const end = addDays(today, 1);
    const last30 = { from: addDays(today, -29), to: end };
    const named = <T extends { key: string | null }>(rows: T[]) =>
      rows.map((r) => ({ ...r, name: this.attribution.name(r.key) ?? null }));
    return {
      now,
      today: summary(this.db, { from: today, to: end }),
      last7: summary(this.db, { from: addDays(today, -6), to: end }),
      last30: summary(this.db, last30),
      burnRate: burnRate(this.db, now),
      daily: timeseries(this.db, last30, 'day', 'agent'),
      projects: named(breakdown(this.db, last30, 'project')),
      models: breakdown(this.db, last30, 'model'),
      billing: this.settings.billing,
    };
  }

  /** Dashboard → Sessions. */
  sessionList(opts: {
    days?: number;
    offset?: number;
    limit?: number;
    sort?: SessionSort;
    agent?: string;
    projectId?: string;
  }) {
    const now = this.now();
    const from = opts.days ? addDays(startOfDay(now), -(opts.days - 1)) : 0;
    const result = sessions(
      this.db,
      { from, to: now + 1 },
      {
        filter: {
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
        },
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.sort ? { sort: opts.sort } : {}),
      },
    );
    return {
      ...result,
      rows: result.rows.map((r) => ({ ...r, projectName: this.attribution.name(r.projectId) ?? null })),
    };
  }

  sessionDetail(sessionId: string) {
    const session = sessionById(this.db, sessionId);
    if (!session) return null;
    return {
      session: { ...session, projectName: this.attribution.name(session.projectId) ?? null },
      events: sessionEvents(this.db, sessionId),
    };
  }

  pricingDetail() {
    return {
      version: this.pricing.version,
      source: this.pricing.tableSource,
      fetchedAt: this.pricing.lastFetchedAt,
      generatedAt: this.pricing.table.generatedAt,
      models: this.pricing.list(),
      unknown: unknownModels(this.db),
    };
  }

  /** Dashboard → Sources (§14.3). */
  sources() {
    const env = this.opts.env ?? process.env;
    const known = {
      claude: claudeProjectDirs(env, [], this.opts.home),
      codex: codexRoots(env, this.opts.home),
      gemini: geminiRoots(env, this.opts.home),
    };
    const collectors = (['claude-jsonl', 'codex-rollout', 'gemini-chat'] as const).map((source) => {
      const c = this.collectors.get(source);
      const roots = c?.stats.roots.length
        ? c.stats.roots
        : source === 'claude-jsonl'
          ? known.claude
          : source === 'codex-rollout'
            ? known.codex
            : known.gemini;
      return {
        source,
        enabled: !!c,
        roots: roots.map((path) => ({ path, exists: existsSync(path) })),
        files: c?.stats.files ?? 0,
        lastEventAt: c?.stats.lastEventAt ?? null,
        parseErrors: c?.stats.parseErrors ?? 0,
      };
    });
    return {
      collectors,
      otlp: this.otlp ? { ...this.otlp.stats } : null,
      userOtelConfig: detectUserOtelConfig(env, this.opts.home),
    };
  }

  /** Deletes events older than `usage.retentionDays` (§11); returns the number removed. */
  applyRetention(): number {
    const cutoff = this.now() - this.settings.retentionDays * DAY_MS;
    const removed = Number(this.db.prepare('DELETE FROM usage_events WHERE ts < ?').run(cutoff).changes);
    this.db.prepare('DELETE FROM sessions WHERE last_event_at < ?').run(cutoff);
    return removed;
  }

  close(): void {
    this.stopCollectors();
    this.statusLine?.stop();
    clearTimeout(this.pendingTimer);
    void this.otlp?.stop();
    this.db.close();
  }
}
