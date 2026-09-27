import { useMemo } from 'react';
import { agentName, tokens, usd } from '../shared/format';
import type { Totals } from '../shared/types';
import { useRequest } from './api';
import { StackedBars } from './chart';

interface Overview {
  now: number;
  today: Totals;
  last7: Totals;
  last30: Totals;
  burnRate: { usdPerHour: number; tokensPerMinute: number };
  daily: { buckets: number[]; series: Record<string, number[]> };
  projects: (Totals & { key: string | null; name: string | null })[];
  models: (Totals & { key: string | null })[];
  billing: Record<string, string>;
}

const SPLIT = [
  { key: 'input', label: 'Input', color: 'var(--accent)' },
  { key: 'output', label: 'Output', color: 'var(--agent)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--info)' },
  { key: 'cacheWrite', label: 'Cache write', color: 'var(--warning)' },
] as const;

function Kpi({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="kpi" data-testid={testId}>
      <div className="label">{label}</div>
      <div className="value mono">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function OverviewTab() {
  const { data, error } = useRequest<Overview>('overview');
  const series = useMemo(
    () =>
      data
        ? Object.entries(data.daily.series)
            .sort(([, a], [, b]) => b.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0))
            .map(([agent, values]) => ({ label: agentName(agent), values }))
        : [],
    [data],
  );
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const approx = Object.values(data.billing).includes('subscription');
  const t = data.last30.tokens;
  const splitTotal = t.input + t.output + t.cacheRead + t.cacheWrite || 1;
  return (
    <div data-testid="usage-overview">
      {approx && <div className="muted">≈ API-equivalent cost for agents billed by subscription.</div>}
      <div className="kpis">
        <Kpi
          testId="usage-kpi-today"
          label="Today"
          value={usd(data.today.costUsd)}
          sub={`${tokens(data.today.tokens.total)} tokens`}
        />
        <Kpi label="Last 7 days" value={usd(data.last7.costUsd)} sub={`${tokens(data.last7.tokens.total)} tokens`} />
        <Kpi label="Last 30 days" value={usd(data.last30.costUsd)} sub={`${data.last30.sessions} sessions`} />
        <Kpi
          label="Burn rate"
          value={`${usd(data.burnRate.usdPerHour)}/h`}
          sub={`${tokens(data.burnRate.tokensPerMinute)} tokens/min`}
        />
      </div>
      <section>
        <h3>DAILY COST · LAST 30 DAYS</h3>
        <StackedBars buckets={data.daily.buckets} series={series} />
        <div className="legend">
          {series.map((s, i) => (
            <span key={s.label}>
              <span
                className="swatch"
                style={{
                  background: `var(${['--agent', '--accent', '--info', '--warning', '--success', '--danger'][i % 6]})`,
                }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h3>TOKENS · LAST 30 DAYS</h3>
        <div className="split">
          {SPLIT.map((s) => (
            <span
              key={s.key}
              title={`${s.label}: ${tokens(t[s.key])}`}
              style={{ width: `${(t[s.key] / splitTotal) * 100}%`, background: s.color }}
            />
          ))}
        </div>
        <div className="legend">
          {SPLIT.map((s) => (
            <span key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label} {tokens(t[s.key])}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h3>PROJECTS · LAST 30 DAYS</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Project</th>
              <th className="num">Cost</th>
              <th className="num">Tokens</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.key ?? 'none'}>
                <td>{p.name ?? (p.key ? 'Removed project' : 'Outside projects')}</td>
                <td className="num">{usd(p.costUsd, { unknown: p.unknownCostEvents > 0 })}</td>
                <td className="num">{tokens(p.tokens.total)}</td>
                <td className="num">
                  {data.last30.costUsd > 0 ? `${Math.round((p.costUsd / data.last30.costUsd) * 100)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3>MODELS · LAST 30 DAYS</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Cost</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.key ?? 'unknown'}>
                <td>{m.key ?? 'unknown'}</td>
                <td className="num">
                  {m.unknownCostEvents > 0 && m.costUsd === 0
                    ? '?'
                    : usd(m.costUsd, { unknown: m.unknownCostEvents > 0 })}
                </td>
                <td className="num">{tokens(m.tokens.input)}</td>
                <td className="num">{tokens(m.tokens.output)}</td>
                <td className="num">{tokens(m.tokens.cacheRead)}</td>
                <td className="num">{tokens(m.tokens.cacheWrite)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
