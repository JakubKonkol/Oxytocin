import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './shared/base.css';
import './sidebar.css';
import { agentName, duration, level, shortModel, SOURCE_NAMES, STATE_LABELS, tokens, usd } from './shared/format';
import type { LiveSession, Progress, SidebarModel, SourceStatus } from './shared/types';

const COMPACT_HEIGHT = 120;

function useHeight(): number {
  const [height, setHeight] = useState(window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

function Session({ s, now, onOpen }: { s: LiveSession; now: number; onOpen: (s: LiveSession) => void }) {
  const state = s.state ?? (now - s.lastEventAt < 60_000 ? 'working' : 'idle');
  return (
    <button
      type="button"
      className="session"
      data-testid="usage-session"
      onClick={() => onOpen(s)}
      title={s.terminalId ? 'Show terminal' : 'Show session details'}
    >
      <div className="title">
        <span className="dot" data-state={state} />
        <span className="name">
          {agentName(s.agent)} · {shortModel(s.model)}
          {s.projectName ? ` · ${s.projectName}` : ''}
        </span>
        <span className="mono">{usd(s.costUsd, { approx: s.approximate, unknown: s.unknownCost })}</span>
      </div>
      <div className="meta">
        {tokens(s.tokens)} tokens · {STATE_LABELS[state] ?? state} · {duration(now - s.startedAt)}
      </div>
    </button>
  );
}

function MenuButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" className="icon" aria-label="Usage menu" title="More actions" onClick={onClick}>
      ⋯
    </button>
  );
}

function Empty({ sources }: { sources: SourceStatus | null }) {
  return (
    <div className="empty" data-testid="usage-empty">
      <div>
        No usage data yet. Start an agent (e.g. <code>claude</code>) in a terminal.
      </div>
      {sources && (
        <ul className="sources">
          {sources.collectors.map((c) => {
            const found = c.enabled && c.roots.some((r) => r.exists);
            return (
              <li key={c.source} className={found ? 'ok' : 'missing'}>
                {found ? '✓' : '✗'} {SOURCE_NAMES[c.source]} {found ? 'found' : 'not found'}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function App() {
  const view = useOxyView();
  const [model, setModel] = useState<SidebarModel | null>(null);
  const [sources, setSources] = useState<SourceStatus | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const height = useHeight();

  useEffect(() => {
    if (!view) return;
    const off = view.onMessage((msg) => {
      const m = msg as { type: string; model?: SidebarModel } & Progress;
      if (m.type === 'model' && m.model) setModel(m.model);
      if (m.type === 'progress') setProgress(m.done >= m.total ? null : m);
    });
    void view.request<SidebarModel>('model').then(setModel);
    return off;
  }, [view]);

  useEffect(() => {
    if (!view || !model || model.hasData) return;
    void view.request<SourceStatus>('sources').then(setSources);
  }, [view, model]);

  const openSession = useCallback(
    (s: LiveSession) => {
      if (!view) return;
      if (s.terminalId) void view.request('focusTerminal', { terminalId: s.terminalId });
      else void view.request('openDashboard', { tab: 'sessions', sessionId: s.sessionId });
    },
    [view],
  );

  const menu = async (e: React.MouseEvent) => {
    if (!view) return;
    const choice = await view.showContextMenu(
      [
        { id: 'dashboard', label: 'Open dashboard' },
        { id: 'pricing', label: 'Refresh pricing' },
        { id: 'settings', label: 'Usage settings' },
        { id: 'sources', label: 'Data sources' },
      ],
      { x: e.clientX, y: e.clientY },
    );
    if (choice === 'dashboard') void view.request('openDashboard', {});
    if (choice === 'pricing') void view.request('refreshPricing');
    if (choice === 'settings') void view.request('openDashboard', { tab: 'pricing' });
    if (choice === 'sources') void view.request('openDashboard', { tab: 'sources' });
  };

  if (!model) return <div className="card muted">Loading…</div>;
  const compact = height < COMPACT_HEIGHT;
  const limit = model.limit;
  const trend = model.burnRate.trend === 'up' ? '▲' : model.burnRate.trend === 'down' ? '▼' : '';
  return (
    <div className={`card${compact ? ' compact' : ''}`} data-testid="usage-card">
      {progress && (
        <div className="muted" data-testid="usage-progress">
          Indexing history… {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
        </div>
      )}
      {!model.hasData ? (
        <>
          <div className="row head">
            <span className="spacer" />
            <MenuButton onClick={(e) => void menu(e)} />
          </div>
          <Empty sources={sources} />
        </>
      ) : (
        <>
          <div className="row head">
            <span className="secondary">Today</span>
            <span
              className="today-value mono"
              data-testid="usage-today"
              title={
                model.today.approximate
                  ? 'API-equivalent cost (subscription billing)'
                  : 'Calculated from tokens and prices'
              }
            >
              {usd(model.today.costUsd, { approx: model.today.approximate })}
            </span>
            {model.today.unknownCost && (
              <span
                className="unknown"
                title="Some models have no price yet — add their rates in the dashboard (Pricing)"
              >
                +?
              </span>
            )}
            <span className="muted">· {tokens(model.today.tokens)} tokens</span>
            <span className="spacer" />
            <span
              className="mono secondary hide-compact"
              data-testid="usage-burn-rate"
              title="Cost of the last 60 minutes"
            >
              {usd(model.burnRate.usdPerHour)}/h{' '}
              <span className={model.burnRate.trend === 'up' ? 'trend-up' : 'trend-down'}>{trend}</span>
            </span>
            <MenuButton onClick={(e) => void menu(e)} />
          </div>
          {limit && (
            <div data-testid="usage-limit" title={model.limits.map((l) => l.label).join('\n')}>
              <div className="bar" data-level={level(limit.ratio)}>
                <span style={{ width: `${Math.min(100, Math.round(limit.ratio * 100))}%` }} />
              </div>
              <div className="limit-label">
                {limit.label}
                {limit.resetsAt ? ` · resets in ${duration(limit.resetsAt - model.now)}` : ''}
              </div>
            </div>
          )}
          {model.sessions.length > 0 && (
            <div className="hide-compact">
              <div className="heading">ACTIVE SESSIONS</div>
              {model.sessions.slice(0, 4).map((s) => (
                <Session key={s.sessionId} s={s} now={model.now} onOpen={openSession} />
              ))}
            </div>
          )}
          {model.project && (
            <div className="muted hide-compact" data-testid="usage-project">
              {model.project.name ?? 'This project'}: today {usd(model.project.todayUsd)} · last 7 days{' '}
              {usd(model.project.last7DaysUsd)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
