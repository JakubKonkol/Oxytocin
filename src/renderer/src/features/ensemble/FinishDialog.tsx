import { GitMerge, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { EnsembleRecord, FinishAction } from '@shared/domain/ensemble';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { EnsembleDialog } from './GateDialog';

const OPTIONS: { action: FinishAction; title: string; description: (branch: string, base: string) => string }[] = [
  {
    action: 'merge',
    title: 'Merge',
    description: (b, base) =>
      `Merges ${b} into ${base} in your checkout (a merge commit keeps the checkpoints). Your checkout must be on ${base} and clean.`,
  },
  {
    action: 'squash',
    title: 'Squash into one commit',
    description: (b, base) =>
      `Commits all changes of ${b} as one commit on ${base}. Your checkout must be on ${base} and clean.`,
  },
  {
    action: 'keep',
    title: 'Keep the branch',
    description: (b) => `Removes the worktree folder and leaves the branch ${b} for you to merge or push yourself.`,
  },
  {
    action: 'discard',
    title: 'Discard',
    description: (b) => `Removes the worktree and deletes the branch ${b}. Everything the agents did is gone.`,
  },
];

/** The last step of a task in a worktree: merge, squash, keep or discard its branch. */
export function FinishDialog({ record, onClose }: { record: EnsembleRecord; onClose: () => void }) {
  const ws = record.run.worktree;
  const [action, setAction] = useState<FinishAction>('merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branch = ws?.branch ?? 'the branch';
  const base = ws?.baseRef ?? 'the base branch';
  const run = async () => {
    if (action === 'discard') {
      const ok = await confirmDialog({
        title: `Discard ${branch}?`,
        description: 'The worktree and the branch are deleted. This cannot be undone.',
        confirmLabel: 'Discard',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await ipc.invoke('ensemble:finish', { taskId: record.task.id, action });
      notify('success', 'Task finished', { description: r.detail });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copySummary = async () => {
    const { text } = await ipc.invoke('ensemble:report', { taskId: record.task.id });
    await ipc.invoke('clipboard:writeText', { text });
    notify('success', 'Summary copied', { description: 'Markdown, ready for a pull request description.' });
  };
  return (
    <EnsembleDialog
      testId="ensemble-finish-dialog"
      title={`Finish "${record.task.title}"`}
      icon={<GitMerge size={18} className="text-success" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => void copySummary()}>
            Copy summary
          </Button>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={action === 'discard' ? 'danger' : 'primary'}
            data-testid="ensemble-finish-run"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {OPTIONS.find((o) => o.action === action)!.title}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="How to finish">
        {OPTIONS.map((o) => (
          <button
            key={o.action}
            type="button"
            role="radio"
            aria-checked={action === o.action}
            data-testid={`ensemble-finish-${o.action}`}
            onClick={() => setAction(o.action)}
            className={cn(
              'flex flex-col gap-0.5 rounded-control border px-3 py-2 text-left',
              action === o.action
                ? 'border-line-focus bg-focus-tint'
                : 'border-line-subtle bg-card hover:bg-card-hover',
            )}
          >
            <span className={cn('font-medium', o.action === 'discard' ? 'text-danger' : 'text-fg')}>{o.title}</span>
            <span className="text-small text-fg-secondary">{o.description(branch, base)}</span>
          </button>
        ))}
        {error && (
          <div
            className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-small text-fg"
            data-testid="ensemble-finish-error"
          >
            {error}
          </div>
        )}
      </div>
    </EnsembleDialog>
  );
}
