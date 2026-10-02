import './ensemble.css';
import type { IDockviewPanelProps } from 'dockview-react';
import { CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Loader2, Plus, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { type EnsembleRecord, isActiveStatus } from '@shared/domain/ensemble';
import { TASK_TEMPLATES } from '@shared/ensemble/presets';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Segmented } from '../projects/settings/controls';
import { createTask, projectRecords, useEnsembleStore } from './ensemble-store';
import { QuickStart } from './QuickStart';
import { TaskView } from './TaskView';

export interface EnsemblePanelParams {
  projectId: string;
}

type Group = 'needs' | 'running' | 'drafts' | 'done';
const GROUP_TITLES: Record<Group, string> = {
  needs: 'Needs you',
  running: 'Running',
  drafts: 'Drafts',
  done: 'Finished',
};

function groupOf(r: EnsembleRecord): Group {
  if (r.run.needs.length > 0 && r.run.status !== 'draft') return 'needs';
  if (isActiveStatus(r.run.status) || r.run.status === 'interrupted') return 'running';
  if (r.run.status === 'draft') return 'drafts';
  return 'done';
}

function TaskListItem({
  record,
  selected,
  onSelect,
}: {
  record: EnsembleRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const total = record.task.pipeline.length;
  const done = record.run.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-testid="ensemble-task-item"
      data-task-id={record.task.id}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-control px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-focus-tint' : 'hover:bg-card-hover',
      )}
    >
      <div className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-ui text-fg">{record.task.title}</span>
        {record.run.needs.length > 0 && record.run.status !== 'draft' && (
          <span className="flex-none rounded-full bg-warning px-1.5 text-[10px] font-semibold text-fg-inverse">
            {record.run.needs.length}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="flex w-full gap-0.5" aria-hidden>
          {record.task.pipeline.map((stage) => {
            const st = record.run.stages.find((s) => s.stageId === stage.id);
            return (
              <span
                key={stage.id}
                className={cn(
                  'h-1 flex-1 rounded-full',
                  st?.status === 'done' || st?.status === 'skipped'
                    ? 'bg-success'
                    : st?.status === 'running'
                      ? 'bg-agent'
                      : st?.status === 'waiting-gate'
                        ? 'bg-warning'
                        : st?.status === 'failed'
                          ? 'bg-danger'
                          : 'bg-line',
                )}
              />
            );
          })}
        </div>
      )}
      <span className="sr-only">
        {done} of {total} stages done
      </span>
    </button>
  );
}

function TaskList({
  records,
  selected,
  onSelect,
  onNew,
  collapsed,
  onToggle,
}: {
  records: EnsembleRecord[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const groups = useMemo(() => {
    const out: Record<Group, EnsembleRecord[]> = { needs: [], running: [], drafts: [], done: [] };
    for (const r of records) out[groupOf(r)].push(r);
    return out;
  }, [records]);
  if (collapsed)
    return (
      <div className="flex w-9 flex-none flex-col items-center gap-1 border-r border-line-subtle py-2">
        <IconButton label="Show tasks" icon={<ChevronRight size={14} />} onClick={onToggle} />
        <IconButton label="New task" icon={<Plus size={14} />} onClick={onNew} />
      </div>
    );
  return (
    <aside className="flex w-56 flex-none flex-col border-r border-line-subtle" data-testid="ensemble-task-list">
      <div className="flex h-9 flex-none items-center gap-1 px-2">
        <span className="oxy-label flex-1">Tasks</span>
        <IconButton label="New task" data-testid="ensemble-new-task" icon={<Plus size={14} />} onClick={onNew} />
        <IconButton label="Hide tasks" icon={<ChevronLeft size={14} />} onClick={onToggle} />
      </div>
      <div role="listbox" aria-label="Ensemble tasks" className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {records.length === 0 && <div className="px-2 py-1 text-small text-fg-muted">No tasks yet.</div>}
        {(Object.keys(GROUP_TITLES) as Group[]).map((g) =>
          groups[g].length === 0 ? null : (
            <div key={g} className="mt-1">
              <div className={cn('oxy-label px-2 py-1', g === 'needs' && 'text-warning')}>
                {GROUP_TITLES[g]} ({groups[g].length})
              </div>
              {groups[g].map((r) => (
                <TaskListItem
                  key={r.task.id}
                  record={r}
                  selected={r.task.id === selected}
                  onSelect={() => onSelect(r.task.id)}
                />
              ))}
            </div>
          ),
        )}
      </div>
    </aside>
  );
}

/** Mini pipeline of a template card. */
function Shape({ steps }: { steps: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-hidden>
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={10} className="text-fg-muted" />}
          <span className="rounded-badge border border-line-subtle bg-input px-1.5 py-0.5 font-mono text-[10px] text-fg-secondary">
            {s}
          </span>
        </span>
      ))}
    </div>
  );
}

/** "Create a task": the quick start (one prompt, a team) or a template in the builder. */
export function NewTask({
  projectId,
  onCreated,
  onCancel,
}: {
  projectId: string;
  onCreated: () => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<'quick' | 'template'>('quick');
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6" data-testid="ensemble-new-task-view">
      <div className="flex items-start gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-card bg-agent/15 text-agent">
          <Workflow size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold text-fg">New Ensemble task</h2>
          <p className="max-w-2xl text-fg-secondary">
            A team of AI agents works on one task in its own git worktree. The planner breaks it down, delegates
            research to helpers and writes the plan; after your approval the others build it. You can watch or take over
            any agent at any time.
          </p>
        </div>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <Segmented
        label="How to start"
        testId="ensemble-new-mode"
        value={mode}
        options={[
          { value: 'quick', label: 'Quick start' },
          { value: 'template', label: 'From a template' },
        ]}
        onChange={setMode}
      />
      {mode === 'quick' ? (
        <QuickStart projectId={projectId} onCreated={onCreated} />
      ) : (
        <TemplateStart projectId={projectId} onCreated={onCreated} />
      )}
    </div>
  );
}

/** A template: the builder opens with its team and pipeline. */
function TemplateStart({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [templateId, setTemplateId] = useState('feature');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const r = await createTask(projectId, templateId, {
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(description.trim() ? { description } : {}),
    });
    setBusy(false);
    if (r) onCreated();
  };
  return (
    <div className="flex flex-col gap-5" data-testid="ensemble-template-start">
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2"
        role="radiogroup"
        aria-label="Template"
      >
        {TASK_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={templateId === t.id}
            data-testid={`ensemble-template-${t.id}`}
            onClick={() => setTemplateId(t.id)}
            className={cn(
              'flex flex-col gap-2 rounded-card border p-3 text-left transition-colors',
              templateId === t.id
                ? 'border-line-focus bg-focus-tint'
                : 'border-line-subtle bg-card hover:bg-card-hover',
            )}
          >
            <span className="font-medium text-fg">{t.title}</span>
            <span className="text-small text-fg-muted">{t.description}</span>
            <Shape steps={t.shape} />
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-small font-medium text-fg-secondary">Title</span>
        <input
          data-testid="ensemble-new-title"
          value={title}
          maxLength={120}
          placeholder="Add CSV export to the reports page"
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-small font-medium text-fg-secondary">Brief (Markdown, you can edit it later)</span>
        <textarea
          data-testid="ensemble-new-description"
          value={description}
          rows={5}
          placeholder="What should be built, constraints, acceptance criteria…"
          onChange={(e) => setDescription(e.target.value)}
          className="resize-y rounded-control border border-line bg-input p-2 font-mono text-ui text-fg placeholder:text-fg-muted"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="primary" data-testid="ensemble-create" disabled={busy} onClick={() => void create()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create task
        </Button>
      </div>
    </div>
  );
}

/** The Ensemble tool: one per workspace (from the "+" menu). */
export function EnsemblePanel({ params }: IDockviewPanelProps<EnsemblePanelParams>) {
  const projectId = params.projectId;
  const all = useEnsembleStore((s) => s.records);
  const loaded = useEnsembleStore((s) => s.loaded);
  const selectedId = useEnsembleStore((s) => s.selected[projectId] ?? null);
  const records = useMemo(() => projectRecords(all, projectId), [all, projectId]);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const selected = records.find((r) => r.task.id === selectedId) ?? null;

  // Open the task that needs attention, else the newest one.
  useEffect(() => {
    if (!loaded || selectedId || creating) return;
    const first = records.find((r) => groupOf(r) === 'needs') ?? records[0];
    if (first) useEnsembleStore.getState().select(projectId, first.task.id);
  }, [loaded, selectedId, records, projectId, creating]);

  useEffect(() => {
    const onNew = (e: Event) => {
      if ((e as CustomEvent<{ projectId: string }>).detail.projectId === projectId) setCreating(true);
    };
    window.addEventListener('oxy:ensemble-new-task', onNew);
    return () => window.removeEventListener('oxy:ensemble-new-task', onNew);
  }, [projectId]);

  const showNew = creating || (loaded && records.length === 0);
  return (
    <div className="flex h-full min-h-0 bg-surface text-ui" data-testid="ensemble-panel" data-project-id={projectId}>
      <TaskList
        records={records}
        selected={showNew ? null : selectedId}
        onSelect={(id) => {
          setCreating(false);
          useEnsembleStore.getState().select(projectId, id);
        }}
        onNew={() => setCreating(true)}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        {!loaded ? (
          <div className="flex flex-1 items-center justify-center text-fg-muted">
            <CircleDashed size={16} className="animate-spin" />
          </div>
        ) : showNew ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <NewTask
              projectId={projectId}
              onCreated={() => setCreating(false)}
              {...(records.length > 0 ? { onCancel: () => setCreating(false) } : {})}
            />
          </div>
        ) : selected ? (
          <TaskView key={selected.task.id} record={selected} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-fg-muted">
            <CheckCircle2 size={20} />
            Select a task.
          </div>
        )}
      </main>
    </div>
  );
}
