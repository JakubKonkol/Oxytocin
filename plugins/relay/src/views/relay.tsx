import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './relay.css';
import {
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_REVIEW_PROMPT,
  type RelayConfig,
  type RelayParticipant,
  type RelayViewState,
} from '../shared/types';

const STATE_LABELS: Record<RelayParticipant['state'], string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  waiting: 'waiting for you',
  unknown: 'running',
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function minutesUntil(at: number): string {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function LimitText({ p, threshold }: { p: RelayParticipant; threshold: number }) {
  if (!p.limit) return <span className="limit muted">no limit data</span>;
  const level = p.limit.percent >= threshold ? 'high' : p.limit.percent >= threshold - 20 ? 'mid' : 'low';
  return (
    <span
      className="limit"
      data-level={level}
      title={p.limit.resetsAt ? `The ${p.limit.window} limit resets in ${minutesUntil(p.limit.resetsAt)}` : undefined}
    >
      {p.limit.percent}% of {p.limit.window}
    </span>
  );
}

function Relay() {
  const view = useOxyView();
  const [state, setState] = useState<RelayViewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    const off = view.onMessage((msg) => setState(msg as RelayViewState));
    let attempts = 0;
    const load = () =>
      view
        .request<RelayViewState>('load')
        .then(setState)
        .catch((e: unknown) => {
          if (++attempts < 5) setTimeout(() => void load(), 1000 * attempts);
          else setError(messageOf(e));
        });
    void load();
    return off;
  }, [view]);

  if (!view || !state) return <div className="relay muted">{error ?? 'Loading…'}</div>;
  const { config } = state;
  const review = config.mode === 'review';
  const set = (patch: Partial<RelayConfig>) => {
    // Shown at once; the backend's answer (with what it kept) follows.
    setState((s) => (s ? { ...s, config: { ...s.config, ...patch } } : s));
    void view
      .request<RelayViewState>('config.set', patch)
      .then(setState)
      .catch((e: unknown) => setError(messageOf(e)));
  };
  const promptKey = review ? 'reviewPrompt' : 'handoffPrompt';
  const savedPrompt = config[promptKey];
  const shown = prompt ?? savedPrompt;
  const move = (id: string, delta: number) => {
    const ids = state.participants.map((p) => p.terminalId);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    set({ order: ids });
  };
  const toggle = (id: string, included: boolean) =>
    set({ excluded: included ? config.excluded.filter((x) => x !== id) : [...config.excluded, id] });

  return (
    <div className="relay" data-testid="relay-panel">
      <div className="row">
        <span className="title">Relay</span>
        <span className="muted">{state.projectName}</span>
        <span className="spacer" />
        <label className="row">
          <input
            type="checkbox"
            data-testid="relay-enabled"
            checked={config.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          On
        </label>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Mode" data-testid="relay-mode">
        {(
          [
            ['handoff', 'Hand off at the limit'],
            ['review', 'Review after each turn'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={config.mode === value}
            data-value={value}
            onClick={() => {
              setPrompt(null);
              set({ mode: value });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="secondary">
        {review
          ? 'When an agent finishes a turn that changed files, the reviewer gets the review prompt. Turns that end while the reviewer works are reviewed together; the reviewer’s own turns start nothing.'
          : 'When an agent finishes its turn and its account’s 5-hour (or weekly) limit is nearly used, the next free agent whose account still has room gets the hand-off prompt. If nobody is free, Relay waits — also for the first agent’s limit to start over.'}{' '}
        Relay types this one prompt and nothing else, so the agents’ context and limits go to the work.
      </p>
      {state.pending && (
        <div className="pending warning" data-testid="relay-pending">
          {state.pending}
        </div>
      )}

      <div className="section">
        <span className="label">Agents in this project</span>
        {state.participants.length === 0 ? (
          <span className="muted" data-testid="relay-empty">
            No AI agents run in this project. Start them from the + menu (AI agents), e.g. Claude Code and Codex CLI.
          </span>
        ) : (
          <div className="agents">
            {state.participants.map((participant, i) => {
              // From the configuration: it changes at once on a click, before the backend answers.
              const p = {
                ...participant,
                included: !config.excluded.includes(participant.terminalId),
                reviewer: config.reviewer === participant.terminalId,
              };
              return (
                <div
                  key={p.terminalId}
                  className={`agent${p.included ? '' : ' excluded'}`}
                  data-testid="relay-agent"
                  data-terminal={p.terminalId}
                >
                  {review ? (
                    <input
                      type="radio"
                      name="reviewer"
                      title="Reviewer"
                      data-testid="relay-reviewer"
                      checked={p.reviewer}
                      onChange={() => set({ reviewer: p.terminalId })}
                    />
                  ) : (
                    <input
                      type="checkbox"
                      title="Takes part"
                      data-testid="relay-include"
                      checked={p.included}
                      onChange={(e) => toggle(p.terminalId, e.target.checked)}
                    />
                  )}
                  <span className="name" title={p.title}>
                    {review ? '' : `${i + 1}. `}
                    {p.label}
                    {review && p.reviewer ? ' — reviewer' : ''}
                  </span>
                  <span className="state" data-state={p.state}>
                    {STATE_LABELS[p.state]}
                  </span>
                  <LimitText p={p} threshold={config.threshold} />
                  <span className="actions">
                    {!review && (
                      <>
                        <button type="button" title="Earlier" disabled={i === 0} onClick={() => move(p.terminalId, -1)}>
                          ↑
                        </button>
                        <button
                          type="button"
                          title="Later"
                          disabled={i === state.participants.length - 1}
                          onClick={() => move(p.terminalId, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      data-testid="relay-send-now"
                      title="Type the prompt into this agent now"
                      disabled={p.state !== 'idle'}
                      onClick={() =>
                        void view
                          .request<{ ok: boolean; error?: string }>('sendNow', { terminalId: p.terminalId })
                          .catch((e: unknown) => setError(messageOf(e)))
                      }
                    >
                      Send now
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {review && !config.reviewer && state.participants.length > 1 && (
          <span className="warning">Pick the reviewer (the round button).</span>
        )}
        {!review && !state.limitsKnown && (
          <span className="warning" data-testid="relay-no-limits">
            No account limits are known yet. Claude Code reports them through the Usage Monitor (Usage → Settings → Show
            Claude subscription limits); Codex CLI after its first turn.
          </span>
        )}
      </div>

      <div className="section">
        {!review ? (
          <label className="row">
            Hand off when the limit is at least
            <input
              type="number"
              min={1}
              max={100}
              data-testid="relay-threshold"
              value={config.threshold}
              onChange={(e) => set({ threshold: Number(e.target.value) })}
            />
            % used
          </label>
        ) : (
          <label className="row">
            <input
              type="checkbox"
              data-testid="relay-only-changes"
              checked={config.onlyWithChanges}
              onChange={(e) => set({ onlyWithChanges: e.target.checked })}
            />
            Only turns that changed files
          </label>
        )}
        <span className="label">{review ? 'Review prompt' : 'Hand-off prompt'}</span>
        <textarea
          data-testid="relay-prompt"
          value={shown}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (prompt !== null && prompt !== savedPrompt) set({ [promptKey]: prompt });
            setPrompt(null);
          }}
        />
        <div className="row muted">
          <span>
            {'{from}'}: the agent that stopped · {'{to}'}: the next one
            {review ? ` · {files}: the changed files` : ` · {limit}: how full its limit is`}
          </span>
          <span className="spacer" />
          <button
            type="button"
            onClick={() => {
              setPrompt(null);
              set({ [promptKey]: review ? DEFAULT_REVIEW_PROMPT : DEFAULT_HANDOFF_PROMPT });
            }}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="section">
        <span className="label">Activity</span>
        {state.log.length === 0 ? (
          <span className="muted">Nothing handed over yet.</span>
        ) : (
          <div className="log" data-testid="relay-log">
            {state.log.map((entry, i) => (
              <div key={`${entry.at}-${i}`} className={`entry${entry.level === 'warning' ? ' warning' : ''}`}>
                <span className="time">{clock(entry.at)}</span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {error && <div className="warning">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Relay />);
