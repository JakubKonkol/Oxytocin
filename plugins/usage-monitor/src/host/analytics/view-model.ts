import type { AgentRef } from '../engine';
import type { Billing } from '../settings';
import type { Database } from '../store/db';
import { activeBlock, BLOCK_MS } from './blocks';
import { type BudgetStatus, evaluateBudget, listBudgets } from './budgets';
import { addDays, startOfDay, type WeekStart } from './periods';
import { burnRate, summary, type TokenTotals } from './queries';

export const LIVE_WINDOW_MS = 10 * 60 * 1000;
const RECENT_ACTIVITY_MS = 30 * 1000;

export interface LiveSession {
  sessionId: string;
  agent: string;
  model: string | null;
  projectId: string | null;
  projectName: string | undefined;
  terminalId: string | null;
  /** Agent state from the core (working / waiting / idle …) when it runs in an Oxytocin terminal. */
  state: string | null;
  costUsd: number;
  unknownCost: boolean;
  tokens: number;
  startedAt: number;
  lastEventAt: number;
  approximate: boolean;
}

export interface LimitBar {
  kind: 'agent-limit' | 'project-budget' | 'global-budget' | 'claude-block' | 'budget';
  label: string;
  ratio: number;
  resetsAt: number | null;
  exhaustedAt?: number | null;
}

export interface SidebarModel {
  now: number;
  hasData: boolean;
  today: { costUsd: number; tokens: number; unknownCost: boolean; approximate: boolean };
  burnRate: { usdPerHour: number; trend: 'up' | 'down' | 'flat' };
  limit: LimitBar | null;
  limits: LimitBar[];
  sessions: LiveSession[];
  project: { id: string; name: string | undefined; todayUsd: number; last7DaysUsd: number } | null;
}

export interface StatusModel {
  todayUsd: number;
  approximate: boolean;
  activeSession: { costUsd: number; agent: string } | null;
  /** New events of a live session within the last 30 s (spinner). */
  busy: boolean;
}

export interface ViewContext {
  now: number;
  activeProjectId: string | null;
  agents: AgentRef[];
  billing: Record<string, Billing>;
  weekStartsOn: WeekStart;
  claudeBlockLimit: { metric: 'tokens' | 'usd'; amount: number } | null;
  projectName: (id: string | null | undefined) => string | undefined;
}

const tokenSum = (t: TokenTotals) => t.total;

/** Sessions with events in the last 10 minutes or with a running agent (§12). */
export function liveSessions(db: Database, ctx: ViewContext): LiveSession[] {
  const running = new Map(ctx.agents.filter((a) => a.sessionId).map((a) => [a.sessionId!, a]));
  const byTerminal = new Map(ctx.agents.map((a) => [a.terminalId, a]));
  const ids = [...running.keys()];
  const rows = db
    .prepare(
      `SELECT s.session_id AS sessionId, s.agent, s.last_model AS model, s.project_id AS projectId,
              s.terminal_id AS terminalId, s.first_event_at AS startedAt, s.last_event_at AS lastEventAt,
              coalesce(sum(e.cost_usd), 0) AS cost,
              coalesce(sum(CASE WHEN e.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
              coalesce(sum(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_5m_tokens
                + e.cache_write_1h_tokens), 0) AS tokens
         FROM sessions s JOIN usage_events e ON e.session_id = s.session_id
        WHERE s.last_event_at >= ? ${ids.length > 0 ? `OR s.session_id IN (${ids.map(() => '?').join(',')})` : ''}
        GROUP BY s.session_id ORDER BY s.last_event_at DESC LIMIT 20`,
    )
    .all(ctx.now - LIVE_WINDOW_MS, ...ids) as unknown as {
    sessionId: string;
    agent: string;
    model: string | null;
    projectId: string | null;
    terminalId: string | null;
    startedAt: number;
    lastEventAt: number;
    cost: number;
    unknown: number;
    tokens: number;
  }[];
  return rows.map((r) => {
    const agent = running.get(r.sessionId) ?? (r.terminalId ? byTerminal.get(r.terminalId) : undefined);
    return {
      sessionId: r.sessionId,
      agent: r.agent,
      model: r.model,
      projectId: r.projectId,
      projectName: ctx.projectName(r.projectId),
      terminalId: r.terminalId ?? agent?.terminalId ?? null,
      state: agent?.state ?? null,
      costUsd: r.cost,
      unknownCost: r.unknown > 0,
      tokens: r.tokens,
      startedAt: r.startedAt,
      lastEventAt: r.lastEventAt,
      approximate: ctx.billing[r.agent] === 'subscription',
    };
  });
}

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const money = (usd: number) => `$${usd.toFixed(2)}`;
const PERIOD_LABEL: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly', block5h: '5-hour' };

function windowLabel(minutes: number | null): string {
  if (!minutes) return '';
  if (minutes === 10080) return 'weekly ';
  if (minutes % 60 === 0) return `${minutes / 60}h `;
  return `${minutes}-minute `;
}

function budgetBar(s: BudgetStatus, kind: LimitBar['kind'], projectName: string | undefined): LimitBar {
  const amount =
    s.budget.metric === 'usd'
      ? money(s.budget.amount)
      : `${Math.round(s.budget.amount).toLocaleString('en-US')} tokens`;
  const scope =
    s.budget.scope === 'project'
      ? `${projectName ?? 'project'} `
      : s.budget.scope === 'agent'
        ? `${s.budget.scopeRef} `
        : '';
  return {
    kind,
    label: `${pct(s.ratio)} of ${scope}${PERIOD_LABEL[s.budget.period]} budget (${amount})`,
    ratio: s.ratio,
    resetsAt: s.range.to > s.range.from ? s.range.to : null,
    exhaustedAt: s.exhaustedAt,
  };
}

/**
 * All limits and the one the sidebar bar shows (§13): a real agent limit with an active session > budget of the
 * active project > global daily budget > the Claude 5-hour block (with an own limit); the most strained one of
 * the first non-empty group. Other budgets appear in the tooltip only.
 */
export function limitBars(
  db: Database,
  ctx: ViewContext,
  live: LiveSession[],
): { limit: LimitBar | null; limits: LimitBar[] } {
  const groups: LimitBar[][] = [[], [], [], [], []];
  const liveAgents = new Set(live.map((s) => s.agent));
  const limits = db
    .prepare(
      'SELECT agent, window, used_percent AS used, window_minutes AS minutes, resets_at AS resetsAt FROM agent_limits',
    )
    .all() as unknown as {
    agent: string;
    window: string;
    used: number | null;
    minutes: number | null;
    resetsAt: number | null;
  }[];
  for (const l of limits) {
    if (l.used === null || (l.resetsAt !== null && l.resetsAt < ctx.now)) continue;
    const bar: LimitBar = {
      kind: 'agent-limit',
      label: `${l.agent === 'codex' ? 'Codex' : l.agent}: ${Math.round(l.used)}% of ${windowLabel(l.minutes)}limit`,
      ratio: l.used / 100,
      resetsAt: l.resetsAt,
    };
    groups[liveAgents.has(l.agent) ? 0 : 4]!.push(bar);
  }
  for (const b of listBudgets(db).filter((x) => x.enabled)) {
    const status = evaluateBudget(db, b, ctx.now, ctx.weekStartsOn);
    if (b.scope === 'project' && b.scopeRef === ctx.activeProjectId)
      groups[1]!.push(budgetBar(status, 'project-budget', ctx.projectName(b.scopeRef)));
    else if (b.scope === 'global' && b.period === 'day') groups[2]!.push(budgetBar(status, 'global-budget', undefined));
    else groups[4]!.push(budgetBar(status, 'budget', ctx.projectName(b.scopeRef)));
  }
  if (ctx.claudeBlockLimit && ctx.claudeBlockLimit.amount > 0) {
    const events = db
      .prepare(
        `SELECT ts, coalesce(cost_usd, 0) AS costUsd,
                input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens AS tokens
           FROM usage_events WHERE agent = 'claude-code' AND ts >= ?`,
      )
      .all(ctx.now - 2 * BLOCK_MS) as unknown as { ts: number; costUsd: number; tokens: number }[];
    const block = activeBlock(events, ctx.now);
    if (block) {
      const used = ctx.claudeBlockLimit.metric === 'usd' ? block.costUsd : block.tokens;
      const ratio = used / ctx.claudeBlockLimit.amount;
      groups[3]!.push({
        kind: 'claude-block',
        label: `${pct(ratio)} of Claude 5-hour block limit`,
        ratio,
        resetsAt: block.end,
      });
    }
  }
  const all = groups.flat();
  const first = groups.find((g) => g.length > 0);
  const limit = first ? first.reduce((a, b) => (b.ratio > a.ratio ? b : a)) : null;
  return { limit, limits: all };
}

export function sidebarModel(db: Database, ctx: ViewContext): SidebarModel {
  const todayFrom = startOfDay(ctx.now);
  const today = summary(db, { from: todayFrom, to: addDays(todayFrom, 1) });
  const agentsToday = (
    db.prepare('SELECT DISTINCT agent FROM usage_events WHERE ts >= ?').all(todayFrom) as { agent: string }[]
  ).map((r) => r.agent);
  const rate = burnRate(db, ctx.now);
  const previous = summary(db, { from: ctx.now - 2 * 60 * 60_000, to: ctx.now - 60 * 60_000 }).costUsd;
  const sessions = liveSessions(db, ctx);
  const { limit, limits } = limitBars(db, ctx, sessions);
  let project: SidebarModel['project'] = null;
  if (ctx.activeProjectId) {
    const filter = { projectId: ctx.activeProjectId };
    project = {
      id: ctx.activeProjectId,
      name: ctx.projectName(ctx.activeProjectId),
      todayUsd: summary(db, { from: todayFrom, to: addDays(todayFrom, 1) }, filter).costUsd,
      last7DaysUsd: summary(db, { from: addDays(todayFrom, -6), to: addDays(todayFrom, 1) }, filter).costUsd,
    };
  }
  const hasData =
    (db.prepare('SELECT 1 AS x FROM usage_events LIMIT 1').get() as { x: number } | undefined) !== undefined;
  return {
    now: ctx.now,
    hasData,
    today: {
      costUsd: today.costUsd,
      tokens: tokenSum(today.tokens),
      unknownCost: today.unknownCostEvents > 0,
      approximate: agentsToday.some((a) => ctx.billing[a] === 'subscription'),
    },
    burnRate: {
      usdPerHour: rate.usdPerHour,
      trend: rate.usdPerHour > previous * 1.1 ? 'up' : rate.usdPerHour < previous * 0.9 ? 'down' : 'flat',
    },
    limit,
    limits,
    sessions,
    project,
  };
}

export function statusModel(db: Database, ctx: ViewContext): StatusModel {
  const todayFrom = startOfDay(ctx.now);
  const today = summary(db, { from: todayFrom, to: addDays(todayFrom, 1) });
  const live = liveSessions(db, ctx);
  const active = live[0];
  return {
    todayUsd: today.costUsd,
    approximate: live.some((s) => s.approximate),
    activeSession: active ? { costUsd: active.costUsd, agent: active.agent } : null,
    busy: live.some((s) => ctx.now - s.lastEventAt <= RECENT_ACTIVITY_MS),
  };
}
