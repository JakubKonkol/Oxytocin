import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './shared/base.css';
import './dashboard/dashboard.css';
import { RevisionContext, ViewContext } from './dashboard/api';
import { BudgetsTab } from './dashboard/budgets';
import { OverviewTab } from './dashboard/overview';
import { PricingTab } from './dashboard/pricing';
import { SessionsTab } from './dashboard/sessions';
import { SourcesTab } from './dashboard/sources';

type Tab = 'overview' | 'sessions' | 'budgets' | 'pricing' | 'sources';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['sessions', 'Sessions'],
  ['budgets', 'Budgets'],
  ['pricing', 'Pricing'],
  ['sources', 'Sources'],
];
const REFRESH_DEBOUNCE_MS = 500;

function App() {
  const view = useOxyView<{ tab?: Tab; sessionId?: string }, { tab: Tab }>();
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const [chosenSession, setSessionId] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  // Until the user navigates, the panel opens where it was asked to (params) or where it was left (state).
  const tab: Tab = chosenTab ?? view?.params?.tab ?? view?.getState()?.tab ?? 'overview';
  const sessionId = chosenSession ?? view?.params?.sessionId;

  useEffect(() => {
    if (!view) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = view.onMessage((msg) => {
      const m = msg as { type: string; tab?: Tab; sessionId?: string };
      if (m.type === 'changed') {
        clearTimeout(timer);
        timer = setTimeout(() => setRevision((r) => r + 1), REFRESH_DEBOUNCE_MS);
      }
      if (m.type === 'navigate') {
        if (m.tab) setTab(m.tab);
        if (m.sessionId) setSessionId(m.sessionId);
      }
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [view]);

  useEffect(() => {
    view?.setState({ tab });
  }, [view, tab]);

  if (!view) return <div className="muted">Connecting…</div>;
  return (
    <ViewContext.Provider value={view}>
      <RevisionContext.Provider value={revision}>
        <div className="dash" data-testid="usage-dashboard">
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="content">
            {tab === 'overview' && <OverviewTab />}
            {tab === 'sessions' && (
              <SessionsTab key={sessionId ?? ''} {...(sessionId ? { initialSession: sessionId } : {})} />
            )}
            {tab === 'budgets' && <BudgetsTab />}
            {tab === 'pricing' && <PricingTab />}
            {tab === 'sources' && <SourcesTab />}
          </div>
        </div>
      </RevisionContext.Provider>
    </ViewContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
