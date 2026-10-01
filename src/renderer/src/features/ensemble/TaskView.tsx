import { DropdownMenu, Tabs } from 'radix-ui';
import {
  AlertTriangle,
  Copy,
  FolderOpen,
  GitBranch,
  GitMerge,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { type EnsembleRecord, isActiveStatus, type Need } from '@shared/domain/ensemble';
import { validateTask, elapsedMs } from '@shared/ensemble/conductor';
import { formatCost, formatDuration } from '@shared/ensemble/flow';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { ActivityTab } from './ActivityTab';
import { AgentsWall } from './AgentsWall';
import { ArtifactsTab } from './ArtifactsTab';
import { Builder } from './Builder';
import { ChangesTab } from './ChangesTab';
import { type EnsembleTab, ensembleCommand, saveTask, useEnsembleStore } from './ensemble-store';
import { FinishDialog } from './FinishDialog';
import { FlowView } from './FlowView';
import { GateDialog } from './GateDialog';
import { askText, StatusPill, useNow } from './ui';

const menuContent = 'z-50 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg';
const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';

const NEED_ICON_TONE: Record<Need['kind'], string> = {
  gate: 'text-accent',
  question: 'text-accent',
  permission: 'text-warning',
  'not-ready': 'text-warning',
  stuck: 'text-warning',
  exited: 'text-danger',
  'loop-limit': 'text-warning',
  'command-failed': 'text-danger',
  'delivery-failed': 'text-danger',
  limit: 'text-warning',
  workspace: 'text-danger',
  finish: 'text-success',
};

/** One item waiting for the user, with its actions. */
function NeedRow({
  record,
  need,
  onGate,
  onFinish,
  onPeek,
}: {
  record: EnsembleRecord;
  need: Need;
  onGate: (stageId: string) => void;
  onFinish: () => void;
  onPeek: (agentId: string) => void;
}) {
  const taskId = record.task.id;
  const resolve = (action: string) => void ensembleCommand(taskId, { type: 'resolve-need', needId: need.id, action });
  const [answer, setAnswer] = useState('');
  const question = need.questionId ? record.run.questions.find((q) => q.id === need.questionId) : undefined;
  const actions: { label: string; run: () => void; primary?: boolean; testId?: string }[] = [];
  switch (need.kind) {
    case 'gate':
      if (need.stageId)
        actions.push({
          label: 'Review…',
          run: () => onGate(need.stageId!),
          primary: true,
          testId: 'ensemble-open-gate',
        });
      break;
    case 'loop-limit':
      actions.push({ label: 'One more round', run: () => resolve('more'), primary: true });
      actions.push({ label: 'Accept as is', run: () => resolve('accept') });
      actions.push({ label: 'Stop task', run: () => resolve('stop') });
      break;
    case 'command-failed':
      actions.push({ label: 'Retry', run: () => resolve('retry'), primary: true });
      actions.push({ label: 'Continue anyway', run: () => resolve('skip') });
      actions.push({ label: 'Stop task', run: () => resolve('stop') });
      break;
    case 'delivery-failed':
      if (need.agentId) actions.push({ label: 'Open terminal', run: () => onPeek(need.agentId!) });
      actions.push({ label: 'Retry', run: () => resolve('retry'), primary: true });
      break;
    case 'stuck':
      if (need.agentId) actions.push({ label: 'Open terminal', run: () => onPeek(need.agentId!), primary: true });
      actions.push({ label: 'Remind', run: () => resolve('remind') });
      if (need.agentId)
        actions.push({
          label: 'Mark as done…',
          run: () =>
            void askText({
              title: "Mark the agent's part as done",
              description: 'The summary is handed on as its result.',
              placeholder: 'What did it produce?',
              confirmLabel: 'Mark as done',
            }).then(
              (summary) => !!summary && ensembleCommand(taskId, { type: 'mark-done', agentId: need.agentId!, summary }),
            ),
        });
      break;
    case 'permission':
    case 'not-ready':
      if (need.agentId) actions.push({ label: 'Open terminal', run: () => onPeek(need.agentId!), primary: true });
      break;
    case 'exited':
      if (need.agentId) actions.push({ label: 'Open terminal', run: () => onPeek(need.agentId!) });
      actions.push({ label: 'Restart agent', run: () => resolve('restart'), primary: true });
      break;
    case 'limit':
      actions.push({ label: 'Continue anyway', run: () => resolve('continue'), primary: true });
      actions.push({ label: 'Stop task', run: () => resolve('stop') });
      break;
    case 'finish':
      actions.push({ label: 'Finish…', run: onFinish, primary: true, testId: 'ensemble-open-finish' });
      break;
    default:
      break;
  }
  return (
    <div
      className="ens-fade-in flex flex-col gap-1.5 rounded-control border border-line-subtle bg-card px-2.5 py-2"
      data-testid="ensemble-need"
      data-kind={need.kind}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className={cn('mt-0.5 flex-none', NEED_ICON_TONE[need.kind])} />
        <span className="min-w-0 flex-1 text-fg">{need.text}</span>
        <div className="flex flex-none flex-wrap justify-end gap-1">
          {actions.map((a) => (
            <Button
              key={a.label}
              size="sm"
              variant={a.primary ? 'primary' : 'secondary'}
              data-testid={a.testId}
              onClick={a.run}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
      {need.kind === 'question' && question && (
        <form
          className="flex gap-1.5 pl-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!answer.trim()) return;
            void ipc
              .invoke('ensemble:answer', { taskId, questionId: question.id, answer: answer.trim() })
              .then((r) => (r.error ? notify('error', r.error) : setAnswer('')));
          }}
        >
          <input
            data-testid="ensemble-answer-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your answer…"
            className="h-7 min-w-0 flex-1 rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted"
          />
          <Button size="sm" variant="primary" type="submit" data-testid="ensemble-answer-send">
            Answer
          </Button>
        </form>
      )}
    </div>
  );
}

export function NeedsBanner({
  record,
  onGate,
  onFinish,
  onPeek,
}: {
  record: EnsembleRecord;
  onGate: (stageId: string) => void;
  onFinish: () => void;
  onPeek: (agentId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const needs = record.run.needs;
  if (needs.length === 0) return null;
  const shown = all ? needs : needs.slice(0, 3);
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-line-subtle bg-warning/5 px-3 py-2"
      data-testid="ensemble-needs"
    >
      <div className="oxy-label text-warning">Needs you ({needs.length})</div>
      {shown.map((n) => (
        <NeedRow key={n.id} record={record} need={n} onGate={onGate} onFinish={onFinish} onPeek={onPeek} />
      ))}
      {needs.length > 3 && (
        <button
          type="button"
          className="self-start text-small text-fg-muted hover:text-fg"
          onClick={() => setAll((a) => !a)}
        >
          {all ? 'Show fewer' : `Show ${needs.length - 3} more`}
        </button>
      )}
    </div>
  );
}

const TAB_LABELS: Record<EnsembleTab, string> = {
  flow: 'Flow',
  agents: 'Agents',
  activity: 'Activity',
  changes: 'Changes',
  artifacts: 'Artifacts',
  task: 'Task',
};

export function TaskView({ record }: { record: EnsembleRecord }) {
  const { task, run } = record;
  const draft = run.status === 'draft';
  const active = isActiveStatus(run.status);
  const now = useNow(run.status === 'running');
  const storedTab = useEnsembleStore((s) => s.tabs[task.id]);
  const tab: EnsembleTab = storedTab ?? (draft ? 'task' : 'flow');
  const setTab = (t: EnsembleTab) => useEnsembleStore.getState().setTab(task.id, t);
  const [gateStage, setGateStage] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const peek = (agentId: string) => {
    useEnsembleStore.getState().setPeek(task.id, agentId);
    if (tab !== 'flow') setTab('flow');
  };

  const start = async () => {
    const pending = useEnsembleStore.getState().drafts[task.id];
    const saved = pending ? await saveTask(pending) : record;
    if (!saved) return;
    const problems = validateTask(saved.task);
    if (problems.length) {
      notify('error', 'The task cannot start yet', { description: problems.map((p) => p.message).join(' ') });
      setTab('task');
      return;
    }
    if (saved.task.workspace.mode === 'current-checkout' && saved.task.agents.some((a) => !a.readOnly)) {
      const ok = await confirmDialog({
        title: 'Agents will change files in your checkout',
        description:
          'This task works in your current checkout, not in a worktree of its own. Agents that write will change your working files directly.',
        confirmLabel: 'Start anyway',
        tone: 'warning',
      });
      if (!ok) return;
    }
    if (await ensembleCommand(task.id, { type: 'start' })) setTab('flow');
  };

  const remove = async () => {
    const ws = run.worktree;
    const ok = await confirmDialog({
      title: `Delete "${task.title}"?`,
      description:
        ws?.mode === 'worktree' && !run.finished
          ? `Its agents stop and the worktree folder is removed. The branch ${ws.branch ?? ''} stays in your repository.`
          : 'The task, its run and its history are removed.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.invoke('ensemble:delete', { taskId: task.id });
    } catch (e) {
      notify('error', 'The task could not be deleted', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const copyReport = async () => {
    const { text } = await ipc.invoke('ensemble:report', { taskId: task.id });
    await ipc.invoke('clipboard:writeText', { text });
    notify('success', 'Report copied', { description: 'Markdown, ready for a pull request description.' });
  };

  const elapsed = run.startedAt ? formatDuration(elapsedMs(run, now)) : null;
  const ws = run.worktree;
  const canFinish = !active && ws?.mode === 'worktree' && !run.finished && run.status !== 'draft';
  const tabs: EnsembleTab[] = draft ? ['task'] : ['flow', 'agents', 'activity', 'changes', 'artifacts', 'task'];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ensemble-task-view" data-task-id={task.id}>
      <header className="flex flex-none flex-col gap-1.5 border-b border-line-subtle px-4 pt-3 pb-2">
        <div className="flex items-center gap-2.5">
          <h2 className="min-w-0 truncate text-[16px] font-semibold text-fg" data-testid="ensemble-task-title">
            {task.title}
          </h2>
          <StatusPill status={run.status} needs={run.needs.length} />
          {elapsed && (
            <span className="font-mono text-small text-fg-muted" title="Running time">
              {elapsed}
            </span>
          )}
          {run.costUsd !== undefined && (
            <span className="font-mono text-small text-fg-muted" title="Cost of the agents (Usage Monitor)">
              {formatCost(run.costUsd)}
            </span>
          )}
          <div className="ml-auto flex flex-none items-center gap-1.5">
            {(draft || run.status === 'done' || run.status === 'stopped' || run.status === 'failed') && (
              <Button variant="primary" size="sm" data-testid="ensemble-start" onClick={() => void start()}>
                <Play size={12} /> {draft ? 'Start' : 'Run again'}
              </Button>
            )}
            {run.status === 'interrupted' && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="ensemble-resume-interrupted"
                  onClick={() => void ensembleCommand(task.id, { type: 'resume-interrupted' })}
                >
                  <RotateCcw size={12} /> Resume
                </Button>
                <Button size="sm" onClick={() => void ensembleCommand(task.id, { type: 'stop' })}>
                  <Square size={11} /> Stop
                </Button>
              </>
            )}
            {(run.status === 'running' || run.status === 'preparing') && (
              <Button
                size="sm"
                data-testid="ensemble-pause"
                onClick={() => void ensembleCommand(task.id, { type: 'pause' })}
              >
                <Pause size={12} /> Pause
              </Button>
            )}
            {run.status === 'paused' && (
              <Button
                size="sm"
                variant="primary"
                data-testid="ensemble-resume"
                onClick={() => void ensembleCommand(task.id, { type: 'resume' })}
              >
                <Play size={12} /> Resume
              </Button>
            )}
            {active && (
              <Button
                size="sm"
                data-testid="ensemble-stop"
                onClick={() =>
                  void confirmDialog({
                    title: 'Stop the task?',
                    description: 'Every agent of the task stops. The worktree and everything written so far stay.',
                    confirmLabel: 'Stop',
                    destructive: true,
                  }).then((ok) => ok && ensembleCommand(task.id, { type: 'stop' }))
                }
              >
                <Square size={11} /> Stop
              </Button>
            )}
            {canFinish && (
              <Button size="sm" variant="primary" data-testid="ensemble-finish" onClick={() => setFinishing(true)}>
                <GitMerge size={12} /> Finish…
              </Button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More" data-testid="ensemble-task-menu" icon={<MoreHorizontal size={15} />} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className={menuContent}>
                  <DropdownMenu.Item
                    className={menuItem}
                    onSelect={() =>
                      void ipc.invoke('ensemble:duplicate', { taskId: task.id }).then((r) => {
                        useEnsembleStore.getState().upsert(r);
                        useEnsembleStore.getState().select(r.task.projectId, r.task.id);
                      })
                    }
                  >
                    <Copy size={13} /> Duplicate
                  </DropdownMenu.Item>
                  {!draft && (
                    <DropdownMenu.Item className={menuItem} onSelect={() => void copyReport()}>
                      <Copy size={13} /> Copy report (Markdown)
                    </DropdownMenu.Item>
                  )}
                  {ws && (
                    <>
                      <DropdownMenu.Item
                        className={menuItem}
                        onSelect={() => void ipc.invoke('ensemble:openFolder', { taskId: task.id, target: 'editor' })}
                      >
                        <FolderOpen size={13} /> Open folder in editor
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={menuItem}
                        onSelect={() => void ipc.invoke('ensemble:openFolder', { taskId: task.id, target: 'files' })}
                      >
                        <FolderOpen size={13} /> Show folder
                      </DropdownMenu.Item>
                    </>
                  )}
                  <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
                  <DropdownMenu.Item className={menuItem} data-testid="ensemble-delete" onSelect={() => void remove()}>
                    <Trash2 size={13} className="text-danger" /> Delete task…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        {ws && (
          <div className="flex min-w-0 items-center gap-3 font-mono text-small text-fg-muted">
            {ws.branch && (
              <span className="flex items-center gap-1" data-testid="ensemble-branch">
                <GitBranch size={11} /> {ws.branch}
              </span>
            )}
            <button
              type="button"
              className="min-w-0 truncate hover:text-fg"
              title="Open in the editor"
              onClick={() => void ipc.invoke('ensemble:openFolder', { taskId: task.id, target: 'editor' })}
            >
              {ws.mode === 'worktree' ? 'worktree' : 'current checkout'} ↗ {ws.path}
            </button>
            {ws.baseRef && (
              <span className="flex-none">
                base {ws.baseRef}
                {ws.baseCommit ? ` @ ${ws.baseCommit.slice(0, 7)}` : ''}
              </span>
            )}
            {run.finished && (
              <span className="flex-none text-success">· {run.finished.detail ?? run.finished.action}</span>
            )}
          </div>
        )}
        {run.status === 'failed' && run.error && (
          <div
            className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1 text-small whitespace-pre-wrap text-fg"
            data-testid="ensemble-error"
          >
            {run.error}
          </div>
        )}
        {run.status === 'paused' && run.pauseReason && run.pauseReason !== 'Paused by you' && (
          <div className="text-small text-warning">{run.pauseReason}</div>
        )}
      </header>
      {!draft && (
        <NeedsBanner record={record} onGate={setGateStage} onFinish={() => setFinishing(true)} onPeek={peek} />
      )}
      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as EnsembleTab)} className="flex min-h-0 flex-1 flex-col">
        {tabs.length > 1 && (
          <Tabs.List className="flex flex-none gap-0.5 border-b border-line-subtle px-3" aria-label="Task views">
            {tabs.map((t) => (
              <Tabs.Trigger
                key={t}
                value={t}
                data-testid={`ensemble-tab-${t}`}
                className="-mb-px border-b-2 border-transparent px-2.5 py-1.5 text-ui text-fg-secondary hover:text-fg data-[state=active]:border-line-focus data-[state=active]:text-fg"
              >
                {TAB_LABELS[t]}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        )}
        <div className="relative min-h-0 flex-1">
          {tab === 'flow' && <FlowView record={record} onGate={setGateStage} />}
          {tab === 'agents' && <AgentsWall record={record} />}
          {tab === 'activity' && <ActivityTab record={record} />}
          {tab === 'changes' && <ChangesTab record={record} />}
          {tab === 'artifacts' && <ArtifactsTab record={record} />}
          {tab === 'task' && <Builder record={record} onStart={() => void start()} />}
        </div>
      </Tabs.Root>
      {gateStage && <GateDialog record={record} stageId={gateStage} onClose={() => setGateStage(null)} />}
      {finishing && <FinishDialog record={record} onClose={() => setFinishing(false)} />}
    </div>
  );
}
