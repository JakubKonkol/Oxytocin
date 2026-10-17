import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentLauncher, AgentSnapshot, TerminalMeta } from '@oxytocin/plugin-api';
import type { Role, Task, TaskInput } from '../shared/task';
import './task.css';

interface Model {
  tasks: Pick<Task, 'id' | 'description' | 'phase'>[];
  task: Task | null;
  launchers: AgentLauncher[];
  agents: AgentSnapshot[];
  terminals: TerminalMeta[];
}
const phases = ['Plan', 'Approve', 'Implement', 'Review'] as const;
const phaseIndex = (t: Task) =>
  t.phase === 'done' ? 4 : t.phase === 'reviewing' ? 3 : t.phase === 'implementing' ? 2 : t.phase === 'ready' ? 1 : 0;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function RolePicker({
  label,
  value,
  onChange,
  model,
  optional = false,
}: {
  label: string;
  value: Role | undefined;
  onChange: (value: Role | undefined) => void;
  model: Model;
  optional?: boolean;
}) {
  const matching = model.terminals.filter(
    (t) => t.profileId === value?.launchId && t.status === 'running' && model.agents.some((a) => a.terminalId === t.id),
  );
  return (
    <div className="role-card">
      <span className="eyebrow">
        {label}
        {optional && <span className="muted"> · optional</span>}
      </span>
      <select
        aria-label={label}
        data-testid={`task-${label.toLowerCase()}`}
        value={value?.launchId ?? ''}
        onChange={(e) => onChange(e.target.value ? { launchId: e.target.value } : undefined)}
      >
        <option value="">{optional ? 'No review' : 'Choose an agent…'}</option>
        {model.launchers.map((a) => (
          <option key={a.launchId} value={a.launchId}>
            {a.name}
            {a.detail ? ` · ${a.detail}` : ''}
          </option>
        ))}
      </select>
      {value && (
        <select
          aria-label={`${label} session`}
          value={value.newSession && !value.terminalId ? 'new' : (value.terminalId ?? '')}
          onChange={(e) =>
            onChange({
              launchId: value.launchId,
              ...(e.target.value === 'new'
                ? { newSession: true }
                : e.target.value
                  ? { terminalId: e.target.value }
                  : {}),
            })
          }
        >
          <option value="">Reuse matching session, or open one</option>
          <option value="new">Open a fresh session</option>
          {matching.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} · {model.agents.find((a) => a.terminalId === t.id)?.state}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function TaskPanel() {
  const view = useOxyView();
  const [model, setModel] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);
  const [description, setDescription] = useState('');
  const [planner, setPlanner] = useState<Role>();
  const [implementer, setImplementer] = useState<Role>();
  const [reviewer, setReviewer] = useState<Role>();
  const [planMode, setPlanMode] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!view) return;
    const off = view.onMessage((raw) => {
      const msg = raw as { type: string; model: Model };
      if (msg.type === 'model') setModel(msg.model);
    });
    void view
      .request<Model>('model')
      .then(setModel)
      .catch((e: unknown) => setError(message(e)));
    return off;
  }, [view]);
  const action = async (method: string, params: unknown) => {
    if (!view || pending) return;
    setPending(true);
    setError('');
    try {
      await view.request(method, params, { timeoutMs: 60_000 });
      setModel(await view.request<Model>('model'));
      if (method === 'create') {
        setCreating(false);
        setDraft(null);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  if (!model)
    return (
      <div className="task-panel">
        <p className="muted">{error || 'Loading Task…'}</p>
      </div>
    );
  const task = creating ? null : model.task;
  const plan = draft ?? task?.plan ?? '';
  const index = task ? phaseIndex(task) : 0;
  return (
    <main className="task-panel" data-testid="task-panel" aria-busy={pending}>
      <header className="toolbar">
        <div>
          <span className="eyebrow">WORKFLOW</span>
          <h1>Task</h1>
        </div>
        <div className="toolbar-actions">
          {model.tasks.length > 0 && (
            <select
              aria-label="Saved task"
              value={task?.id ?? ''}
              disabled={pending}
              onChange={(e) => {
                if (!e.target.value) return;
                setCreating(false);
                setDraft(null);
                void action('select', e.target.value);
              }}
            >
              <option value="" disabled>
                Choose a task
              </option>
              {model.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description.slice(0, 70)}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={pending}
            onClick={() => {
              setCreating(true);
              setDraft(null);
              setError('');
            }}
            data-testid="task-new"
          >
            + New task
          </button>
        </div>
      </header>
      <div className="steps">
        {phases.map((label, i) => (
          <div key={label} className="step" data-active={index === i} data-complete={index > i}>
            <span className="step-number">{index > i ? '✓' : i + 1}</span>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {(error || task?.error) && (
        <div role="alert" className="error">
          {error || task?.error}
        </div>
      )}
      {!task ? (
        <section className="compose">
          <div>
            <h2>What needs to be done?</h2>
            <p className="muted">Plan together, approve the document, then hand it to your implementer.</p>
          </div>
          <textarea
            aria-label="Task description"
            data-testid="task-description"
            placeholder="Describe the change and what a good result looks like…"
            maxLength={8000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
          />
          <div className="roles">
            <RolePicker label="Planner" value={planner} onChange={setPlanner} model={model} />
            <RolePicker label="Implementer" value={implementer} onChange={setImplementer} model={model} />
            <RolePicker label="Reviewer" value={reviewer} onChange={setReviewer} model={model} optional />
          </div>
          <label className="check">
            <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} />
            Start new Claude sessions in plan mode
          </label>
          <p className="muted hint">
            Existing sessions keep their context and mode. Enable /plan in an existing Claude terminal before starting.
            Choose a fresh session from + → AI Agents when you want an empty context.
          </p>
          {model.launchers.length === 0 && (
            <p className="muted">No agents available. Detect or configure them in Settings → AI Agents.</p>
          )}
          <div className="footer">
            <span className="muted">Ordinary terminals. One plan per hand-off.</span>
            <button
              className="primary"
              data-testid="task-start"
              disabled={pending || !description.trim() || !planner || !implementer}
              onClick={() => {
                if (planner && implementer)
                  void action('create', {
                    description,
                    planner,
                    implementer,
                    ...(reviewer ? { reviewer } : {}),
                    planMode,
                  } satisfies TaskInput);
              }}
            >
              {pending ? 'Starting…' : 'Start planning →'}
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="summary">
            <span className="eyebrow">{task.phase === 'done' ? 'COMPLETED' : 'CURRENT TASK'}</span>
            <h2>{task.description}</h2>
            <div className="sessions">
              {(['planner', 'implementer', 'reviewer'] as const).map((role) => {
                const r = task[role];
                if (!r) return null;
                const a = model.launchers.find((a) => a.launchId === r.launchId);
                const running = model.agents.find((a) => a.terminalId === r.terminalId);
                return (
                  <button
                    key={role}
                    disabled={!running || pending}
                    onClick={() => void action('show', { id: task.id, role })}
                  >
                    <span className="eyebrow">{role}</span>
                    <span>{a?.name ?? r.launchId}</span>
                    <span className="muted">{running?.state ?? 'not running'}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="plan-section">
            <div className="plan-heading">
              <div>
                <span className="eyebrow">{task.approvedPlan ? 'APPROVED DOCUMENT' : 'PLAN DOCUMENT'}</span>
                <h2>
                  {task.approvedPlan ? 'Plan approved' : plan ? 'Ready for your approval' : 'Waiting for the planner'}
                </h2>
              </div>
              {task.approvedAt && <span className="muted">{new Date(task.approvedAt).toLocaleString()}</span>}
            </div>
            <p className="muted hint">
              {task.approvedPlan
                ? 'The implementer received this exact plan. Conversations stay in their own terminals.'
                : 'Claude’s native plan document is captured automatically. You can also paste or refine a plan below before approving it.'}
            </p>
            {task.source && (
              <p className="document-path" title={task.source}>
                {task.source}
              </p>
            )}
            <textarea
              aria-label="Plan document"
              data-testid="task-plan"
              className="plan-document"
              value={task.approvedPlan ?? plan}
              readOnly={!!task.approvedPlan || pending}
              maxLength={90000}
              placeholder="The plan will appear here. You can also paste a Markdown plan."
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="footer">
              <button
                className="subtle"
                disabled={pending}
                onClick={() => {
                  if (deleteArmed) {
                    void action('delete', task.id);
                    setDeleteArmed(false);
                  } else setDeleteArmed(true);
                }}
              >
                {deleteArmed ? 'Confirm deletion' : 'Delete task'}
              </button>
              <div className="toolbar-actions">
                {!task.approvedPlan && (
                  <button disabled={pending} onClick={() => void action('retryPlan', task.id)}>
                    Retry planning prompt
                  </button>
                )}
                {!task.approvedPlan && (
                  <button
                    className="primary"
                    data-testid="task-approve"
                    disabled={pending || !plan.trim()}
                    onClick={() => void action('approve', { id: task.id, plan })}
                  >
                    Approve & implement →
                  </button>
                )}
                {task.approvedPlan && task.phase === 'ready' && (
                  <button
                    className="primary"
                    data-testid="task-implement"
                    disabled={pending}
                    onClick={() => void action('implement', task.id)}
                  >
                    Retry implementation →
                  </button>
                )}
                {task.phase === 'implementing' && task.reviewer && (
                  <button
                    className="primary"
                    data-testid="task-review"
                    disabled={pending}
                    onClick={() => void action('review', task.id)}
                  >
                    Implementation ready · Review →
                  </button>
                )}
                {['implementing', 'reviewing'].includes(task.phase) && (
                  <button data-testid="task-done" disabled={pending} onClick={() => void action('done', task.id)}>
                    Mark done ✓
                  </button>
                )}
              </div>
            </div>
          </section>
        </>
      )}
      {pending && (
        <p className="muted" role="status">
          Waiting for the agent terminal…
        </p>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<TaskPanel />);
