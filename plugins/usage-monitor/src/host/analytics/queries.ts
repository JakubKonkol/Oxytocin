import type { Database } from '../store/db';
import { startOfDay, type Range } from './periods';

export interface Filter {
  projectId?: string | null;
  agent?: string;
  sessionId?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface Totals {
  costUsd: number;
  /** Events without a known price (cost shown as "?"). */
  unknownCostEvents: number;
  tokens: TokenTotals;
  events: number;
  sessions: number;
}

const SUMS = `count(*) AS events,
  coalesce(sum(cost_usd), 0) AS cost,
  coalesce(sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
  coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
  coalesce(sum(cache_read_tokens), 0) AS cacheRead,
  coalesce(sum(cache_write_5m_tokens + cache_write_1h_tokens), 0) AS cacheWrite,
  coalesce(sum(reasoning_tokens), 0) AS reasoning,
  count(DISTINCT session_id) AS sessions`;

interface SumRow {
  events: number;
  cost: number;
  unknown: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  sessions: number;
}

function where(range: Range, filter: Filter = {}): { sql: string; params: (string | number | null)[] } {
  const parts = ['ts >= ?', 'ts < ?'];
  const params: (string | number | null)[] = [range.from, range.to];
  if (filter.projectId !== undefined) {
    parts.push(filter.projectId === null ? 'project_id IS NULL' : 'project_id = ?');
    if (filter.projectId !== null) params.push(filter.projectId);
  }
  if (filter.agent) {
    parts.push('agent = ?');
    params.push(filter.agent);
  }
  if (filter.sessionId) {
    parts.push('session_id = ?');
    params.push(filter.sessionId);
  }
  return { sql: parts.join(' AND '), params };
}

function toTotals(r: SumRow): Totals {
  const tokens = {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    reasoning: r.reasoning,
    total: r.input + r.output + r.cacheRead + r.cacheWrite,
  };
  return { costUsd: r.cost, unknownCostEvents: r.unknown, tokens, events: r.events, sessions: r.sessions };
}

/** Totals of a range. */
export function summary(db: Database, range: Range, filter?: Filter): Totals {
  const w = where(range, filter);
  return toTotals(db.prepare(`SELECT ${SUMS} FROM usage_events WHERE ${w.sql}`).get(...w.params) as unknown as SumRow);
}

export type GroupKey = 'project' | 'agent' | 'model';
const COLUMN: Record<GroupKey, string> = { project: 'project_id', agent: 'agent', model: 'model' };

/** Totals per project / agent / model, most expensive first. */
export function breakdown(
  db: Database,
  range: Range,
  by: GroupKey,
  filter?: Filter,
): (Totals & { key: string | null })[] {
  const w = where(range, filter);
  const rows = db
    .prepare(
      `SELECT ${COLUMN[by]} AS key, ${SUMS} FROM usage_events WHERE ${w.sql} GROUP BY ${COLUMN[by]} ORDER BY cost DESC`,
    )
    .all(...w.params) as unknown as (SumRow & { key: string | null })[];
  return rows.map((r) => ({ key: r.key, ...toTotals(r) }));
}

/** Cost per bucket (local hours or days) and group, for charts. */
export function timeseries(
  db: Database,
  range: Range,
  bucket: 'hour' | 'day',
  by: GroupKey,
  filter?: Filter,
): { buckets: number[]; series: Record<string, number[]> } {
  const w = where(range, filter);
  const rows = db
    .prepare(`SELECT ts, ${COLUMN[by]} AS key, cost_usd AS cost FROM usage_events WHERE ${w.sql}`)
    .all(...w.params) as unknown as { ts: number; key: string | null; cost: number | null }[];
  const buckets: number[] = [];
  const step = (ts: number) => {
    const d = new Date(ts);
    if (bucket === 'hour') d.setHours(d.getHours() + 1);
    else d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  const floor = (ts: number) => {
    if (bucket === 'day') return startOfDay(ts);
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  };
  for (let t = floor(range.from); t < range.to; t = step(t)) buckets.push(t);
  const index = new Map(buckets.map((b, i) => [b, i]));
  const series: Record<string, number[]> = {};
  for (const r of rows) {
    const i = index.get(floor(r.ts));
    if (i === undefined) continue;
    const key = r.key ?? 'unknown';
    series[key] ??= new Array<number>(buckets.length).fill(0);
    series[key][i]! += r.cost ?? 0;
  }
  return { buckets, series };
}

export interface SessionRow extends Totals {
  sessionId: string;
  agent: string;
  model: string | null;
  projectId: string | null;
  terminalId: string | null;
  cwd: string | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  reportedCostUsd: number | null;
  primarySource: string | null;
}

const SESSION_SELECT = `SELECT s.session_id AS sessionId, s.agent, s.last_model AS model, s.project_id AS projectId,
    s.terminal_id AS terminalId, s.cwd, s.first_event_at AS firstEventAt, s.last_event_at AS lastEventAt,
    s.reported_cost_usd AS reportedCostUsd, s.primary_source AS primarySource,
    count(e.id) AS events, coalesce(sum(e.cost_usd), 0) AS cost,
    coalesce(sum(CASE WHEN e.id IS NOT NULL AND e.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
    coalesce(sum(e.input_tokens), 0) AS input, coalesce(sum(e.output_tokens), 0) AS output,
    coalesce(sum(e.cache_read_tokens), 0) AS cacheRead,
    coalesce(sum(e.cache_write_5m_tokens + e.cache_write_1h_tokens), 0) AS cacheWrite,
    coalesce(sum(e.reasoning_tokens), 0) AS reasoning, 1 AS sessions
  FROM sessions s LEFT JOIN usage_events e ON e.session_id = s.session_id`;

type SessionSqlRow = SumRow & Omit<SessionRow, keyof Totals>;
const toSession = (r: SessionSqlRow): SessionRow => ({
  sessionId: r.sessionId,
  agent: r.agent,
  model: r.model,
  projectId: r.projectId,
  terminalId: r.terminalId,
  cwd: r.cwd,
  firstEventAt: r.firstEventAt,
  lastEventAt: r.lastEventAt,
  reportedCostUsd: r.reportedCostUsd,
  primarySource: r.primarySource,
  ...toTotals(r),
});

export type SessionSort = 'lastEventAt' | 'cost' | 'tokens';

/** Sessions active in a range (paged). */
export function sessions(
  db: Database,
  range: Range,
  opts: { filter?: Filter; offset?: number; limit?: number; sort?: SessionSort } = {},
): { rows: SessionRow[]; total: number } {
  const parts = ['s.last_event_at >= ?', 's.first_event_at < ?'];
  const params: (string | number)[] = [range.from, range.to];
  if (opts.filter?.projectId) {
    parts.push('s.project_id = ?');
    params.push(opts.filter.projectId);
  }
  if (opts.filter?.agent) {
    parts.push('s.agent = ?');
    params.push(opts.filter.agent);
  }
  const order =
    opts.sort === 'cost'
      ? 'cost DESC'
      : opts.sort === 'tokens'
        ? '(input + output + cacheRead + cacheWrite) DESC'
        : 's.last_event_at DESC';
  const rows = db
    .prepare(`${SESSION_SELECT} WHERE ${parts.join(' AND ')} GROUP BY s.session_id ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as unknown as SessionSqlRow[];
  const total = (
    db.prepare(`SELECT count(*) AS n FROM sessions s WHERE ${parts.join(' AND ')}`).get(...params) as { n: number }
  ).n;
  return { rows: rows.map(toSession), total };
}

export function sessionById(db: Database, sessionId: string): SessionRow | undefined {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.session_id = ? GROUP BY s.session_id`).get(sessionId) as
    SessionSqlRow | undefined;
  return row ? toSession(row) : undefined;
}

export interface SessionEvent {
  ts: number;
  model: string;
  costUsd: number | null;
  tokens: number;
  isSubagent: boolean;
}

/** Events of a session for its detail view (timeline + sparkline). */
export function sessionEvents(db: Database, sessionId: string, limit = 2000): SessionEvent[] {
  return (
    db
      .prepare(
        `SELECT ts, model, cost_usd AS costUsd,
                input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens AS tokens,
                is_subagent AS isSubagent
           FROM usage_events WHERE session_id = ? ORDER BY ts LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as (Omit<SessionEvent, 'isSubagent'> & { isSubagent: number })[]
  ).map((e) => ({ ...e, isSubagent: e.isSubagent === 1 }));
}

/** Models seen without a price (Pricing tab: "Unknown model 'x' — add its rates"). */
export function unknownModels(db: Database): { rawModel: string; events: number; lastSeen: number }[] {
  return db
    .prepare(
      `SELECT raw_model AS rawModel, count(*) AS events, max(ts) AS lastSeen FROM usage_events
        WHERE cost_usd IS NULL AND cost_source = 'computed' GROUP BY raw_model ORDER BY lastSeen DESC`,
    )
    .all() as unknown as { rawModel: string; events: number; lastSeen: number }[];
}

/** USD per hour over the last 60 minutes and tokens per minute over the last 10 (§12). */
export function burnRate(db: Database, now: number, filter?: Filter): { usdPerHour: number; tokensPerMinute: number } {
  const hour = summary(db, { from: now - 60 * 60_000, to: now + 1 }, filter);
  const tenMinutes = summary(db, { from: now - 10 * 60_000, to: now + 1 }, filter);
  return { usdPerHour: hour.costUsd, tokensPerMinute: tenMinutes.tokens.total / 10 };
}

export interface UsageGroup {
  key: string;
  sessionIds?: string[];
  terminalIds?: string[];
}

/** Cost and tokens per group of sessions/terminals (an agent of an Ensemble task); events counted once per group. */
export function groupTotals(db: Database, groups: UsageGroup[]): Record<string, { costUsd: number; tokens: number }> {
  const out: Record<string, { costUsd: number; tokens: number }> = {};
  for (const g of groups) {
    const sessionIds = (g.sessionIds ?? []).slice(0, 50);
    const terminalIds = (g.terminalIds ?? []).slice(0, 50);
    if (sessionIds.length === 0 && terminalIds.length === 0) continue;
    const parts: string[] = [];
    if (sessionIds.length) parts.push(`session_id IN (${sessionIds.map(() => '?').join(',')})`);
    if (terminalIds.length) parts.push(`terminal_id IN (${terminalIds.map(() => '?').join(',')})`);
    const row = db
      .prepare(
        `SELECT coalesce(sum(cost_usd), 0) AS cost,
                coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0) AS tokens
           FROM usage_events WHERE ${parts.join(' OR ')}`,
      )
      .get(...sessionIds, ...terminalIds) as { cost: number; tokens: number };
    out[g.key] = { costUsd: row.cost, tokens: row.tokens };
  }
  return out;
}
