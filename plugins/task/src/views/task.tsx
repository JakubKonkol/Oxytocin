import { useOxyView } from '@oxytocin/plugin-sdk/react';
import '@oxytocin/plugin-sdk/theme.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentLauncher, AgentSnapshot, TerminalMeta } from '@oxytocin/plugin-api';
import type { PlanVersion, Role, RoleName, Task, TaskInput } from '../shared/task';
import { renderPlan } from './markdown';
import './task.css';

interface Model {
  project: { id: string; name: string } | null;
  tasks: Pick<Task, 'id' | 'description' | 'phase'>[];
  task: Task | null;
  planWaiting: boolean;
  launchers: AgentLauncher[];
  agents: AgentSnapshot[];
  terminals: TerminalMeta[];
}
const phases = ['Plan', 'Approve', 'Implement', 'Review'] as const;
const phaseIndex = (t: Task) =>
  t.phase === 'done'
    ? 4
    : t.phase === 'reviewing'
      ? 3
      : t.phase === 'implementing'
        ? 2
        : t.phase === 'ready' || t.phase === 'rejected'
          ? 1
          : 0;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusLabel: Record<PlanVersion['status'], string> = {
  pending: 'awaiting approval',
  revised: 'feedback sent',
  superseded: 'replaced',
  approved: 'approved',
  rejected: 'rejected',
};
const originLabel: Record<PlanVersion['origin'], string> = {
  hook: 'from Claude Code',
  capture: 'from the plan document',
  edit: 'edited in Task',
};

function PlanView({ plan, testId }: { plan: string; testId: string }) {
  const html = useMemo(() => renderPlan(plan), [plan]);
  return (
    <div
      className="plan-view markdown"
      data-testid={testId}
      // Links would navigate the panel away from Task.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) e.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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
  // A session chosen earlier that is no longer running falls back to a fresh one.
  const chosen = matching.some((t) => t.id === value?.terminalId) ? value?.terminalId : undefined;
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
          value={chosen ?? ''}
          onChange={(e) =>
            onChange({ launchId: value.launchId, ...(e.target.value ? { terminalId: e.target.value } : {}) })
          }
        >
          <option value="">New session (clean context)</option>
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
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState('');
  const shownProject = useRef<string | undefined>(undefined);
  const shownTask = useRef<string | undefined>(undefined);
  const receiveModel = useCallback((next: Model) => {
    if (shownProject.current !== next.project?.id) {
      shownProject.current = next.project?.id;
      const reset = (role: Role | undefined) => (role ? { launchId: role.launchId } : undefined);
      setPlanner(reset);
      setImplementer(reset);
      setReviewer(reset);
      setDeleteArmed(false);
      setCreating(false);
    }
    if (shownTask.current !== next.task?.id) {
      shownTask.current = next.task?.id;
      setDraft(null);
      setEditing(false);
      setFeedback('');
      setShownVersion(null);
    }
    setModel(next);
  }, []);
  useEffect(() => {
    if (!view) return;
    const off = view.onMessage((raw) => {
      const msg = raw as { type: string; model: Model };
      if (msg.type === 'model') receiveModel(msg.model);
    });
    void view
      .request<Model>('model')
      .then(receiveModel)
      .catch((e: unknown) => setError(message(e)));
    return off;
  }, [view, receiveModel]);
  const action = async (method: string, params: unknown) => {
    if (!view || pending) return false;
    setPending(true);
    setError('');
    try {
      await view.request(method, params, { timeoutMs: 120_000 });
      receiveModel(await view.request<Model>('model'));
      if (method === 'create') {
        setCreating(false);
        setDraft(null);
      }
      return true;
    } catch (e) {
      setError(message(e));
      return false;
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
  const awaiting = !!task && !task.approvedPlan && (task.phase === 'planning' || task.phase === 'ready');
  const hooked = !!task?.hookTerminalId && task.planner.terminalId === task.hookTerminalId;
  const roleName = (role: RoleName) => model.launchers.find((a) => a.launchId === task?.[role]?.launchId)?.name ?? role;
  const outbox = task?.outbox;
  const versions = task?.versions ?? [];
  const viewed = shownVersion !== null ? versions[shownVersion] : undefined;
  const heading = !task
    ? ''
    : task.approvedPlan
      ? 'Plan approved'
      : task.phase === 'rejected'
        ? 'Plan rejected'
        : task.phase === 'ready' && plan
          ? 'Plan awaiting approval'
          : versions.some((v) => v.status === 'revised')
            ? 'The planner is revising the plan'
            : 'Waiting for the planner';
  // Without a plan yet, a planner that is not Claude Code may need one pasted.
  const showEditor = awaiting && (editing || (!plan && !hooked));
  return (
    <main className="task-panel" data-testid="task-panel" aria-busy={pending}>
      <header className="toolbar">
        <div>
          <span className="eyebrow">WORKFLOW{model.project ? ` · ${model.project.name}` : ''}</span>
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
            disabled={pending || !model.project}
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
      {task && outbox && (
        <div className="delivery" role="status" data-testid="task-delivery">
          <span>
            Waiting to hand the {outbox.role === 'planner' ? 'feedback' : 'prompt'} to the {outbox.role} (
            {roleName(outbox.role)}){outbox.waiting ? `: ${outbox.waiting}` : '.'} It is sent as soon as the agent is
            ready.
          </span>
          <span className="toolbar-actions">
            <button
              className="subtle"
              disabled={pending}
              onClick={() => void action('show', { id: task.id, role: outbox.role })}
            >
              Show terminal
            </button>
            <button className="subtle" disabled={pending} onClick={() => void action('cancelDelivery', task.id)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {!model.project ? (
        <p className="muted">Open a project to plan a task.</p>
      ) : !task ? (
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
            Each role gets a new session with a clean context unless you choose a running one. A Claude planner starts
            in plan mode (Opus, high effort) with edits in the project blocked; its finished plan appears here and
            Claude waits for your decision. The implementer receives only the task and the approved plan.
          </p>
          {model.launchers.length === 0 && (
            <p className="muted">No agents available. Detect or configure them in Settings → AI Agents.</p>
          )}
          <div className="footer">
            <span className="muted">Ordinary terminals. Every stage starts when you say so.</span>
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
            <span className="eyebrow">
              {task.phase === 'done' ? 'COMPLETED' : task.phase === 'rejected' ? 'REJECTED' : 'CURRENT TASK'}
            </span>
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
                <h2 data-testid="task-plan-status">{heading}</h2>
              </div>
              <div className="toolbar-actions">
                {task.approvedAt && <span className="muted">{new Date(task.approvedAt).toLocaleString()}</span>}
                {awaiting && plan && !viewed && (
                  <button
                    className="subtle"
                    data-testid="task-edit"
                    disabled={pending}
                    onClick={() => {
                      if (editing) setDraft(null);
                      setEditing(!editing);
                    }}
                  >
                    {editing ? 'Discard edits' : 'Edit'}
                  </button>
                )}
              </div>
            </div>
            <p className="muted hint">
              {task.approvedPlan
                ? 'The implementer received this exact plan. Conversations stay in their own terminals.'
                : model.planWaiting
                  ? 'Claude is waiting for your decision. Approve the plan, send feedback (Claude revises it right away) or reject it.'
                  : hooked
                    ? 'Claude sends its finished plan here and waits for your decision. If it stopped waiting (Esc in its terminal), feedback is typed into its terminal once it is ready.'
                    : 'The planner’s plan document is captured automatically. You can also paste or refine a plan below before approving it.'}
            </p>
            {(viewed?.source ?? task.source) && (
              <p className="document-path" title={viewed?.source ?? task.source}>
                {viewed?.source ?? task.source}
              </p>
            )}
            {viewed ? (
              <div className="version-banner" role="status">
                <span>
                  Version {shownVersion! + 1} · {statusLabel[viewed.status]}
                </span>
                <button className="subtle" onClick={() => setShownVersion(null)}>
                  Back to the current plan
                </button>
              </div>
            ) : null}
            {viewed ? (
              <PlanView plan={viewed.plan} testId="task-version-view" />
            ) : showEditor ? (
              <textarea
                aria-label="Plan document"
                data-testid="task-plan"
                className="plan-document"
                value={plan}
                readOnly={pending}
                maxLength={90000}
                placeholder="The plan will appear here. You can also paste a Markdown plan."
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (task.approvedPlan ?? plan) ? (
              <PlanView plan={task.approvedPlan ?? plan} testId="task-plan-view" />
            ) : (
              <p className="muted plan-empty">The plan will appear here when the planner finishes it.</p>
            )}
            {awaiting && task.phase === 'ready' && plan && !viewed && (
              <div className="feedback">
                <textarea
                  aria-label="Feedback for the planner"
                  data-testid="task-feedback"
                  placeholder="What should the planner change?"
                  maxLength={8000}
                  rows={3}
                  value={feedback}
                  disabled={pending}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </div>
            )}
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
                {awaiting &&
                  !(task.phase === 'ready' && plan) &&
                  !outbox &&
                  (!!task.error || !model.agents.some((a) => a.terminalId === task.planner.terminalId)) && (
                    <button
                      data-testid="task-retry-plan"
                      disabled={pending}
                      onClick={() => void action('retryPlan', task.id)}
                    >
                      Retry planning prompt
                    </button>
                  )}
                {awaiting && plan && (
                  <button data-testid="task-reject" disabled={pending} onClick={() => void action('reject', task.id)}>
                    Reject
                  </button>
                )}
                {awaiting && task.phase === 'ready' && plan && (
                  <button
                    data-testid="task-revise"
                    disabled={pending || !feedback.trim() || !!viewed}
                    onClick={() => {
                      void action('revise', { id: task.id, feedback }).then((ok) => {
                        if (ok) setFeedback('');
                      });
                    }}
                  >
                    Revise
                  </button>
                )}
                {awaiting && (
                  <button
                    className="primary"
                    data-testid="task-approve"
                    disabled={pending || !plan.trim() || !!viewed}
                    onClick={() => void action('approve', { id: task.id, plan })}
                  >
                    Approve & implement →
                  </button>
                )}
                {task.approvedPlan &&
                  (task.phase === 'ready' || (task.phase === 'implementing' && !!task.error && !outbox)) && (
                    <button
                      className="primary"
                      data-testid="task-implement"
                      disabled={pending}
                      onClick={() => void action('implement', task.id)}
                    >
                      Retry implementation →
                    </button>
                  )}
                {task.reviewer &&
                  (task.phase === 'implementing' || (task.phase === 'reviewing' && !!task.error && !outbox)) && (
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
            {versions.length > 0 && (
              <details className="versions" data-testid="task-versions">
                <summary>
                  Plan versions <span className="muted">({versions.length})</span>
                </summary>
                <ol>
                  {versions.map((v, i) => (
                    <li key={`${v.at}-${i}`} data-status={v.status}>
                      <button className="subtle" onClick={() => setShownVersion(shownVersion === i ? null : i)}>
                        Version {i + 1}
                      </button>
                      <span className="muted">
                        {new Date(v.at).toLocaleString()} · {originLabel[v.origin]} · {statusLabel[v.status]}
                      </span>
                      {v.feedback && <blockquote>{v.feedback}</blockquote>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
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
