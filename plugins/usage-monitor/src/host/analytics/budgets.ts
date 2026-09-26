import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../store/db';
import { activeBlock, BLOCK_MS, type BlockEvent } from './blocks';
import { type Period, periodKey, periodRange, type Range, type WeekStart } from './periods';
import { burnRate, type Filter, summary } from './queries';

export const BudgetSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  scope: z.enum(['global', 'project', 'agent']),
  scopeRef: z.string().min(1).nullable().optional(),
  period: z.enum(['day', 'week', 'month', 'block5h']),
  metric: z.enum(['usd', 'tokens']),
  amount: z.number().positive(),
  thresholds: z.array(z.number().positive().max(10)).max(5).default([0.8, 1]),
  enabled: z.boolean().default(true),
});
export type BudgetInput = z.input<typeof BudgetSchema>;
export type Budget = z.output<typeof BudgetSchema> & { id: string; createdAt: number };

interface BudgetRow {
  id: string;
  name: string;
  scope: Budget['scope'];
  scope_ref: string | null;
  period: Period;
  metric: Budget['metric'];
  amount: number;
  thresholds: string;
  enabled: number;
  created_at: number;
}

export function listBudgets(db: Database): Budget[] {
  return (db.prepare('SELECT * FROM budgets ORDER BY created_at').all() as unknown as BudgetRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    scopeRef: r.scope_ref,
    period: r.period,
    metric: r.metric,
    amount: r.amount,
    thresholds: JSON.parse(r.thresholds) as number[],
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  }));
}

export function saveBudget(db: Database, input: BudgetInput, now: number): Budget {
  const b = BudgetSchema.parse(input);
  if (b.scope !== 'global' && !b.scopeRef) throw new Error('A project or agent budget needs its project or agent');
  const id = b.id ?? randomUUID();
  const thresholds = [...new Set(b.thresholds)].sort((x, y) => x - y);
  db.prepare(
    `INSERT INTO budgets (id, name, scope, scope_ref, period, metric, amount, thresholds, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, scope = excluded.scope, scope_ref = excluded.scope_ref,
       period = excluded.period, metric = excluded.metric, amount = excluded.amount, thresholds = excluded.thresholds,
       enabled = excluded.enabled`,
  ).run(
    id,
    b.name,
    b.scope,
    b.scope === 'global' ? null : (b.scopeRef ?? null),
    b.period,
    b.metric,
    b.amount,
    JSON.stringify(thresholds),
    b.enabled ? 1 : 0,
    now,
  );
  return listBudgets(db).find((x) => x.id === id)!;
}

export function deleteBudget(db: Database, id: string): void {
  db.prepare('DELETE FROM budget_alerts WHERE budget_id = ?').run(id);
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
}

export interface BudgetStatus {
  budget: Budget;
  spent: number;
  ratio: number;
  range: Range;
  periodKey: string;
  /** "At the current rate, the budget runs out at ~HH:MM" (only within the period). */
  exhaustedAt: number | null;
}

const filterOf = (b: Budget): Filter =>
  b.scope === 'project' ? { projectId: b.scopeRef ?? null } : b.scope === 'agent' ? { agent: b.scopeRef ?? '' } : {};

function blockEvents(db: Database, filter: Filter, now: number): BlockEvent[] {
  const parts = ['ts >= ?'];
  const params: (string | number)[] = [now - 2 * BLOCK_MS];
  if (filter.projectId) {
    parts.push('project_id = ?');
    params.push(filter.projectId);
  }
  // 5-hour blocks are a Claude subscription concept: other agents count only when the budget is scoped to them.
  parts.push('agent = ?');
  params.push(filter.agent ?? 'claude-code');
  return db
    .prepare(
      `SELECT ts, coalesce(cost_usd, 0) AS costUsd,
              input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens AS tokens
         FROM usage_events WHERE ${parts.join(' AND ')}`,
    )
    .all(...params) as unknown as BlockEvent[];
}

export function evaluateBudget(db: Database, b: Budget, now: number, weekStartsOn: WeekStart = 'monday'): BudgetStatus {
  const filter = filterOf(b);
  let range: Range;
  let spent: number;
  if (b.period === 'block5h') {
    const block = activeBlock(blockEvents(db, filter, now), now);
    range = block ? { from: block.start, to: block.end } : { from: now, to: now };
    spent = block ? (b.metric === 'usd' ? block.costUsd : block.tokens) : 0;
  } else {
    range = periodRange(b.period, now, weekStartsOn);
    const t = summary(db, { from: range.from, to: range.to }, filter);
    spent = b.metric === 'usd' ? t.costUsd : t.tokens.total;
  }
  const ratio = b.amount > 0 ? spent / b.amount : 0;
  let exhaustedAt: number | null = null;
  if (ratio < 1 && range.to > now) {
    const rate = burnRate(db, now, filter);
    const perHour = b.metric === 'usd' ? rate.usdPerHour : rate.tokensPerMinute * 60;
    if (perHour > 0) {
      const at = now + ((b.amount - spent) / perHour) * 60 * 60 * 1000;
      if (at < range.to) exhaustedAt = at;
    }
  }
  return { budget: b, spent, ratio, range, periodKey: periodKey(b.period, range.from), exhaustedAt };
}

export interface BudgetAlert {
  budgetId: string;
  name: string;
  threshold: number;
  spent: number;
  amount: number;
  metric: Budget['metric'];
}

/** Thresholds crossed for the first time in their period (each fires once per period — `budget_alerts`). */
export function checkBudgetAlerts(db: Database, statuses: BudgetStatus[], now: number): BudgetAlert[] {
  const insert = db.prepare(
    'INSERT INTO budget_alerts (budget_id, period_key, threshold, fired_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const alerts: BudgetAlert[] = [];
  for (const s of statuses) {
    if (!s.budget.enabled || s.range.to <= s.range.from) continue;
    // Only the highest crossed threshold is announced; lower ones are recorded as fired too.
    const crossed = s.budget.thresholds.filter((t) => s.ratio >= t);
    let fresh: number | undefined;
    for (const t of crossed) if (Number(insert.run(s.budget.id, s.periodKey, t, now).changes) > 0) fresh = t;
    if (fresh !== undefined)
      alerts.push({
        budgetId: s.budget.id,
        name: s.budget.name,
        threshold: Math.max(...crossed),
        spent: s.spent,
        amount: s.budget.amount,
        metric: s.budget.metric,
      });
  }
  return alerts;
}
