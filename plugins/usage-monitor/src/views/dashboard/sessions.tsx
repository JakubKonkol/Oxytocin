import { useState } from 'react';
import { agentName, dateTime, duration, shortModel, tokens, usd } from '../shared/format';
import type { Totals } from '../shared/types';
import { useRequest, useView } from './api';
import { Sparkline } from './chart';

interface SessionRow extends Totals {
  sessionId: string;
  agent: string;
  model: string | null;
  projectId: string | null;
  projectName: string | null;
  terminalId: string | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  reportedCostUsd: number | null;
  primarySource: string | null;
}

interface Detail {
  session: SessionRow;
  events: { ts: number; model: string; costUsd: number | null; tokens: number; isSubagent: boolean }[];
}

const PAGE = 50;

function SessionDetail({ id }: { id: string }) {
  const view = useView();
  const { data } = useRequest<Detail | null>('session', { id });
  if (!data) return <div className="detail muted">Loading…</div>;
  const s = data.session;
  return (
    <div className="detail" data-testid="usage-session-detail">
      <div className="toolbar">
        <strong>
          {agentName(s.agent)} · {shortModel(s.model)}
        </strong>
        <span className="muted">{s.sessionId}</span>
        <span style={{ flex: 1 }} />
        {s.terminalId && (
          <button type="button" onClick={() => void view.request('focusTerminal', { terminalId: s.terminalId })}>
            Show terminal
          </button>
        )}
      </div>
      <Sparkline values={data.events.map((e) => e.costUsd ?? 0)} />
      <div className="muted">
        {data.events.length} requests · calculated {usd(s.costUsd, { precise: true })}
        {s.reportedCostUsd !== null
          ? ` · cost reported by the agent ${usd(s.reportedCostUsd, { precise: true })}`
          : ''}{' '}
        · source {s.primarySource ?? '—'}
      </div>
    </div>
  );
}

export function SessionsTab({ initialSession }: { initialSession?: string }) {
  const [days, setDays] = useState(30);
  const [agent, setAgent] = useState('');
  const [sort, setSort] = useState<'lastEventAt' | 'cost' | 'tokens'>('lastEventAt');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(initialSession);
  const { data, error } = useRequest<{ rows: SessionRow[]; total: number }>('sessions', {
    ...(days ? { days } : {}),
    ...(agent ? { agent } : {}),
    sort,
    offset: page * PAGE,
    limit: PAGE,
  });
  return (
    <div data-testid="usage-sessions">
      <div className="toolbar">
        <select
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setPage(0);
          }}
          aria-label="Range"
        >
          <option value={1}>Today</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={0}>All time</option>
        </select>
        <select
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            setPage(0);
          }}
          aria-label="Agent"
        >
          <option value="">All agents</option>
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="gemini-cli">Gemini CLI</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="lastEventAt">Most recent</option>
          <option value="cost">Most expensive</option>
          <option value="tokens">Most tokens</option>
        </select>
        {data && (
          <span className="muted">
            {data.total} sessions
            {data.total > PAGE && (
              <>
                {' · '}
                <button type="button" className="link" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>{' '}
                <button
                  type="button"
                  className="link"
                  disabled={(page + 1) * PAGE >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <table className="grid">
        <thead>
          <tr>
            <th>Start</th>
            <th>Agent</th>
            <th>Model</th>
            <th>Project</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Cache</th>
            <th className="num">Cost</th>
            <th className="num">Duration</th>
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((s) => (
            <tr
              key={s.sessionId}
              className={`clickable${selected === s.sessionId ? ' selected' : ''}`}
              data-testid="usage-session-row"
              onClick={() => setSelected(s.sessionId === selected ? undefined : s.sessionId)}
            >
              <td>{s.firstEventAt ? dateTime(s.firstEventAt) : '—'}</td>
              <td>
                {agentName(s.agent)}
                {s.terminalId ? ' ▸' : ''}
              </td>
              <td>{shortModel(s.model)}</td>
              <td>{s.projectName ?? '—'}</td>
              <td className="num">{tokens(s.tokens.input)}</td>
              <td className="num">{tokens(s.tokens.output)}</td>
              <td className="num">{tokens(s.tokens.cacheRead + s.tokens.cacheWrite)}</td>
              <td className="num">{usd(s.costUsd, { unknown: s.unknownCostEvents > 0 })}</td>
              <td className="num">
                {s.firstEventAt && s.lastEventAt ? duration(s.lastEventAt - s.firstEventAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && <SessionDetail id={selected} />}
    </div>
  );
}
