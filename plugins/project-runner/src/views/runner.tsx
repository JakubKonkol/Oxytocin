import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './runner.css';
import type { ProfileState, RunnerState } from '../shared/types';
import { formatEnv, statusLabel } from './format';

type View = NonNullable<ReturnType<typeof useOxyView>>;

const ICONS = {
  play: 'M7 5.5v13l11-6.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  logs: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  add: 'M12 5v14M5 12h14',
  rescan: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5',
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        d={ICONS[name]}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={name === 'play' || name === 'stop' ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

function IconButton(props: {
  icon: keyof typeof ICONS;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  testId?: string;
  disabled?: boolean;
  tone?: 'run' | 'stop';
}) {
  return (
    <button
      type="button"
      className="icon"
      aria-label={props.label}
      title={props.label}
      data-testid={props.testId}
      data-tone={props.tone}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

interface Draft {
  id?: string;
  name: string;
  command: string;
  cwd: string;
  env: string;
  url: string;
}

const emptyDraft = (): Draft => ({ name: '', command: '', cwd: '', env: '', url: '' });

function ProfileForm(props: { draft: Draft; onSave: (d: Draft) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState(props.draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof Draft) => ({
    value: draft[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={(e) => void submit(e)} data-testid="runner-form">
      <div className="form-title">{draft.id ? 'Edit run profile' : 'New run profile'}</div>
      <label>
        Name
        <input {...field('name')} placeholder="web" autoFocus data-testid="runner-form-name" />
      </label>
      <label>
        Command
        <input {...field('command')} placeholder="npm run dev" className="mono" data-testid="runner-form-command" />
      </label>
      <label>
        Folder <span className="muted">(relative to the project root)</span>
        <input {...field('cwd')} placeholder="apps/web" className="mono" data-testid="runner-form-cwd" />
      </label>
      <label>
        Environment <span className="muted">(KEY=value per line)</span>
        <textarea {...field('env')} rows={2} className="mono" placeholder="PORT=4000" data-testid="runner-form-env" />
      </label>
      <label>
        URL <span className="muted">(optional, when the app does not print it)</span>
        <input {...field('url')} placeholder="http://localhost:4000" className="mono" data-testid="runner-form-url" />
      </label>
      {error && (
        <div className="error" data-testid="runner-form-error">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy} data-testid="runner-form-save">
          Save
        </button>
      </div>
    </form>
  );
}

/** The question a starting app waits on, with its answers (the app would otherwise look like it hangs). */
function PromptBar(props: { p: ProfileState; view: View; onError: (message: string) => void }) {
  const { p, view, onError } = props;
  const prompt = p.run.prompt!;
  const [text, setText] = useState('');
  const answer = (value: string) => {
    void view
      .request('answer', { profileId: p.id, text: value, promptId: prompt.id })
      .catch((e: unknown) => onError(messageOf(e)));
  };
  return (
    <div className="prompt" data-testid="runner-prompt" role="alert">
      <div className="prompt-text" data-testid="runner-prompt-text">
        {prompt.text}
      </div>
      <div className="prompt-actions">
        {prompt.yesNo ? (
          <>
            <button type="button" className="primary" onClick={() => answer('y')} data-testid="runner-prompt-yes">
              Yes
            </button>
            <button type="button" onClick={() => answer('n')} data-testid="runner-prompt-no">
              No
            </button>
          </>
        ) : (
          <form
            className="prompt-form"
            onSubmit={(e) => {
              e.preventDefault();
              answer(text);
              setText('');
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Answer…"
              aria-label="Answer"
              className="mono"
              data-testid="runner-prompt-input"
            />
            <button type="submit" className="primary" data-testid="runner-prompt-send">
              Send
            </button>
          </form>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => void view.request('logs', { profileId: p.id }).catch((e: unknown) => onError(messageOf(e)))}
          data-testid="runner-prompt-terminal"
        >
          Open terminal
        </button>
      </div>
    </div>
  );
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '');

function ProfileRow(props: {
  p: ProfileState;
  view: View;
  onEdit: (p: ProfileState) => void;
  onError: (message: string) => void;
}) {
  const { p, view, onError } = props;
  const { run } = p;
  const active = run.status === 'starting' || run.status === 'running' || run.status === 'stopping';
  const request = (method: string) => () => {
    void view.request(method, { profileId: p.id }).catch((e: unknown) => onError(messageOf(e)));
  };
  const menu = async (e: React.MouseEvent) => {
    const items = [
      { id: 'edit', label: 'Edit…' },
      { id: 'copy', label: 'Copy Command' },
      ...(p.edited ? [{ id: 'reset', label: 'Reset to Detected' }] : []),
      { id: 'sep', label: '', separator: true },
      { id: 'delete', label: p.source === 'custom' ? 'Delete' : 'Hide' },
    ];
    try {
      const picked = await view.showContextMenu(items, { x: e.clientX, y: e.clientY });
      if (picked === 'edit') props.onEdit(p);
      else if (picked === 'copy') await view.copyToClipboard(p.command);
      else if (picked === 'reset') await view.request('reset', { profileId: p.id });
      else if (picked === 'delete') await view.request('delete', { profileId: p.id });
    } catch (err) {
      onError(messageOf(err));
    }
  };
  return (
    <div className="profile-item">
      <div
        className="profile"
        data-testid="runner-profile"
        data-profile-id={p.id}
        data-status={run.status}
        data-prompt={run.prompt ? 'true' : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          void menu(e);
        }}
      >
        <span className="dot" data-status={run.status} title={statusLabel(run)} />
        <div className="main">
          <div className="title">
            <span className="name">{p.name}</span>
            {p.framework && <span className="framework">{p.framework}</span>}
            {run.startedBy === 'agent' && active && (
              <span className="agent" title="Started by an AI agent (MCP)" data-testid="runner-agent-badge">
                agent
              </span>
            )}
          </div>
          <div className="detail">
            {run.url && active ? (
              <a
                href={run.url}
                data-testid="runner-url"
                onClick={(e) => {
                  e.preventDefault();
                  void view.request('openUrl', { url: run.url });
                }}
              >
                {run.url.replace(/^https?:\/\//, '')}
              </a>
            ) : (
              <span className="mono muted command" title={p.cwd ? `${p.cwd}: ${p.command}` : p.command}>
                {p.command}
              </span>
            )}
            <span className="status-text" data-testid="runner-status">
              {run.prompt ? 'waiting for input' : statusLabel(run)}
            </span>
          </div>
        </div>
        <div className="actions">
          {active ? (
            <>
              <IconButton
                icon="restart"
                label="Restart"
                onClick={request('restart')}
                testId="runner-restart"
                disabled={run.status === 'stopping'}
              />
              <IconButton
                icon="stop"
                label="Stop"
                tone="stop"
                onClick={request('stop')}
                testId="runner-stop"
                disabled={run.status === 'stopping'}
              />
            </>
          ) : (
            <IconButton icon="play" label="Run" tone="run" onClick={request('start')} testId="runner-start" />
          )}
          <IconButton
            icon="logs"
            label="Show logs (terminal)"
            onClick={request('logs')}
            testId="runner-logs"
            disabled={!run.terminalId}
          />
          <IconButton icon="more" label="More actions" onClick={(e) => void menu(e)} testId="runner-more" />
        </div>
      </div>
      {run.prompt && active && run.status !== 'stopping' && (
        <PromptBar key={run.prompt.id} p={p} view={view} onError={onError} />
      )}
    </div>
  );
}

/** Agents run these apps through Oxytocin's MCP server; connecting them happens in Settings → Agent Tools. */
function AgentsFooter({ view }: { view: View }) {
  return (
    <div className="footer" data-testid="runner-mcp">
      <span className="muted" title="Tools run_list_profiles, run_start_profile, … of Oxytocin's MCP server">
        AI agents can run these apps
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="link"
        onClick={() => void view.request('openAgentTools')}
        data-testid="runner-agent-tools"
      >
        Agent Tools
      </button>
    </div>
  );
}

function App() {
  const view = useOxyView();
  const [state, setState] = useState<RunnerState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    const off = view.onMessage((msg) => {
      if ((msg as RunnerState).type !== 'state') return;
      setState(msg as RunnerState);
      setError(null);
    });
    let attempts = 0;
    // The backend may still be starting (or reloading): try again a few times before showing the error.
    const load = () =>
      view
        .request<RunnerState>('load')
        .then((s) => {
          setState(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if (++attempts < 5) setTimeout(() => void load(), 1000 * attempts);
          else setError(messageOf(e));
        });
    void load();
    return off;
  }, [view]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const save = useCallback(
    async (d: Draft) => {
      if (!view) return;
      await view.request('save', {
        ...(d.id ? { id: d.id } : {}),
        input: { name: d.name, command: d.command, cwd: d.cwd, env: d.env, url: d.url },
      });
      setDraft(null);
    },
    [view],
  );

  if (!view || (!state && !error)) return <div className="empty muted">Loading…</div>;
  if (!state) return <div className="empty error">{error}</div>;
  if (!state.project)
    return (
      <div className="empty muted" data-testid="runner-no-project">
        Open a project to run its apps.
      </div>
    );
  const edit = (p: ProfileState) =>
    setDraft({
      id: p.id,
      name: p.name,
      command: p.command,
      cwd: p.cwd,
      env: formatEnv(p.env),
      url: p.url ?? '',
    });
  return (
    <div className="runner" data-testid="runner" data-project={state.project.id}>
      <div className="header">
        <span className="project" title={state.project.rootPath}>
          {state.project.name}
        </span>
        {state.scanning && <span className="muted">scanning…</span>}
        <span className="spacer" />
        <IconButton icon="add" label="Add run profile" onClick={() => setDraft(emptyDraft())} testId="runner-add" />
        <IconButton
          icon="rescan"
          label="Detect apps again"
          onClick={() => void view.request('rescan').catch((e: unknown) => setNotice(messageOf(e)))}
          testId="runner-rescan"
        />
      </div>
      {notice && (
        <div className="notice error" data-testid="runner-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {draft ? (
        <ProfileForm draft={draft} onSave={save} onCancel={() => setDraft(null)} />
      ) : state.profiles.length === 0 ? (
        <div className="empty muted" data-testid="runner-empty">
          {state.scanning ? 'Looking for apps…' : 'No runnable apps found.'}{' '}
          {!state.scanning && (
            <button type="button" className="link" onClick={() => setDraft(emptyDraft())}>
              Add a run profile
            </button>
          )}
        </div>
      ) : (
        <div className="list">
          {state.profiles.map((p) => (
            <ProfileRow key={p.id} p={p} view={view} onEdit={edit} onError={setNotice} />
          ))}
        </div>
      )}
      <AgentsFooter view={view} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
