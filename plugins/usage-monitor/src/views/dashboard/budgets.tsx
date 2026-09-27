import { useState } from 'react';
import { clock, level, tokens, usd } from '../shared/format';
import { useRequest, useView } from './api';

interface Budget {
  id: string;
  name: string;
  scope: 'global' | 'project' | 'agent';
  scopeRef: string | null;
  period: 'day' | 'week' | 'month' | 'block5h';
  metric: 'usd' | 'tokens';
  amount: number;
  thresholds: number[];
  enabled: boolean;
}
interface BudgetStatus {
  budget: Budget;
  spent: number;
  ratio: number;
  range: { from: number; to: number };
  exhaustedAt: number | null;
}

const PERIODS = { day: 'Day', week: 'Week', month: 'Month', block5h: '5-hour block' } as const;
const empty = {
  name: '',
  scope: 'global' as Budget['scope'],
  scopeRef: '',
  period: 'day' as Budget['period'],
  metric: 'usd' as Budget['metric'],
  amount: '',
  thresholds: '80, 100',
};

function amountText(metric: Budget['metric'], v: number) {
  return metric === 'usd' ? usd(v) : `${tokens(v)} tokens`;
}

function BlockLimit() {
  const view = useView();
  const { data: settings, reload } = useRequest<Record<string, unknown>>('settings');
  const current = (settings?.['usage.limits.claudeBlock'] ?? {}) as { metric?: string; amount?: number };
  const [metric, setMetric] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const m = metric ?? current.metric ?? 'usd';
  const a = amount ?? (current.amount ? String(current.amount) : '');
  const save = async () => {
    const value = Number(a) > 0 ? { metric: m, amount: Number(a) } : {};
    await view.request('settings.set', { key: 'usage.limits.claudeBlock', value });
    setMetric(null);
    setAmount(null);
    reload();
  };
  return (
    <div className="setting">
      <div>
        <div>Claude 5-hour block limit</div>
        <div className="desc">
          An estimate of your own. For the real 5-hour and weekly limits of a Claude subscription, turn on Claude
          subscription limits in Pricing.
        </div>
      </div>
      <div className="toolbar" style={{ margin: 0 }}>
        <select value={m} onChange={(e) => setMetric(e.target.value)} aria-label="Block limit metric">
          <option value="usd">USD</option>
          <option value="tokens">Tokens</option>
        </select>
        <input
          value={a}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="none"
          size={10}
          aria-label="Block limit amount"
        />
        <button type="button" onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

export function BudgetsTab() {
  const view = useView();
  const { data, error, reload } = useRequest<BudgetStatus[]>('budgets');
  const { data: projects } = useRequest<{ id: string; name: string }[]>('projects');
  const [form, setForm] = useState(empty);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<typeof empty>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async () => {
    setFormError(null);
    try {
      await view.request('budget.save', {
        name: form.name,
        scope: form.scope,
        scopeRef: form.scope === 'global' ? null : form.scopeRef || null,
        period: form.period,
        metric: form.metric,
        amount: Number(form.amount),
        thresholds: form.thresholds
          .split(',')
          .map((t) => Number(t.trim()) / 100)
          .filter((t) => t > 0),
      });
      setForm(empty);
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div data-testid="usage-budgets">
      <div className="form">
        <label>
          Name
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Daily budget" />
        </label>
        <label>
          Scope
          <select value={form.scope} onChange={(e) => set({ scope: e.target.value as Budget['scope'], scopeRef: '' })}>
            <option value="global">All usage</option>
            <option value="project">Project</option>
            <option value="agent">Agent</option>
          </select>
        </label>
        {form.scope !== 'global' && (
          <label>
            {form.scope === 'project' ? 'Project' : 'Agent'}
            <select value={form.scopeRef} onChange={(e) => set({ scopeRef: e.target.value })}>
              <option value="">Choose…</option>
              {form.scope === 'project'
                ? projects?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                : ['claude-code', 'codex', 'gemini-cli'].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
            </select>
          </label>
        )}
        <label>
          Period
          <select value={form.period} onChange={(e) => set({ period: e.target.value as Budget['period'] })}>
            {Object.entries(PERIODS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Metric
          <select value={form.metric} onChange={(e) => set({ metric: e.target.value as Budget['metric'] })}>
            <option value="usd">USD</option>
            <option value="tokens">Tokens</option>
          </select>
        </label>
        <label>
          Amount
          <input value={form.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" />
        </label>
        <label>
          Notify at (%)
          <input value={form.thresholds} onChange={(e) => set({ thresholds: e.target.value })} />
        </label>
        <button type="button" onClick={() => void submit()} disabled={!form.name || !(Number(form.amount) > 0)}>
          Add budget
        </button>
      </div>
      {formError && <div className="error">{formError}</div>}
      {error && <div className="error">{error}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th>Budget</th>
            <th>Scope</th>
            <th>Period</th>
            <th style={{ width: '30%' }}>Used</th>
            <th className="num">Spent / amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.budget.id} data-testid="usage-budget-row">
              <td>{s.budget.name}</td>
              <td>
                {s.budget.scope === 'global'
                  ? 'All usage'
                  : s.budget.scope === 'project'
                    ? (projects?.find((p) => p.id === s.budget.scopeRef)?.name ?? s.budget.scopeRef)
                    : s.budget.scopeRef}
              </td>
              <td>{PERIODS[s.budget.period]}</td>
              <td>
                <div className="bar" data-level={level(s.ratio)}>
                  <span style={{ width: `${Math.min(100, s.ratio * 100)}%` }} />
                </div>
                <div className="muted">
                  {Math.round(s.ratio * 100)}%
                  {s.exhaustedAt ? ` · at the current rate, the budget runs out at ~${clock(s.exhaustedAt)}` : ''}
                </div>
              </td>
              <td className="num">
                {amountText(s.budget.metric, s.spent)} / {amountText(s.budget.metric, s.budget.amount)}
              </td>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={() => void view.request('budget.delete', { id: s.budget.id }).then(reload)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section style={{ marginTop: 16 }}>
        <BlockLimit />
      </section>
    </div>
  );
}
