import { FolderOpen, RefreshCw } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { EnsembleChange, EnsembleRecord } from '@shared/domain/ensemble';
import type { FileDiffContent } from '@shared/domain/git';
import { languageIdFor } from '@shared/utils/language';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { inputSized } from './ui';

const DiffEditorView = lazy(() => import('../diff/DiffEditorView'));

interface Range {
  label: string;
  from?: string;
  to?: string;
}

/** Files the task changed in its worktree: the whole task, or one stage between two checkpoints. */
export function ChangesTab({ record }: { record: EnsembleRecord }) {
  const { task, run } = record;
  const settings = useSettingsStore((s) => s.settings);
  const ranges = useMemo<Range[]>(() => {
    const out: Range[] = [{ label: 'Whole task (base → now)' }];
    let previous = run.worktree?.baseCommit;
    for (const c of run.checkpoints) {
      out.push({
        label: `${c.title} (${c.commit.slice(0, 7)})`,
        ...(previous ? { from: previous } : {}),
        to: c.commit,
      });
      previous = c.commit;
    }
    return out;
  }, [run.checkpoints, run.worktree?.baseCommit]);
  const [rangeIndex, setRangeIndex] = useState(0);
  const range = ranges[rangeIndex] ?? ranges[0]!;
  const [files, setFiles] = useState<EnsembleChange[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiffContent | null>(null);
  const [tick, setTick] = useState(0);
  const live = run.status === 'running';

  useEffect(() => {
    let alive = true;
    void ipc
      .invoke('ensemble:changes', {
        taskId: task.id,
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      })
      .then(
        (list) => alive && setFiles(list),
        () => alive && setFiles([]),
      );
    return () => {
      alive = false;
    };
  }, [task.id, range.from, range.to, tick, run.checkpoints.length]);

  // While the task runs the working tree changes: refresh every few seconds.
  useEffect(() => {
    if (!live || range.to) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [live, range.to]);

  const file = files?.find((f) => f.path === selected);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void ipc
      .invoke('ensemble:fileDiff', {
        taskId: task.id,
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      })
      .then((r) => {
        if (!alive) return;
        setDiff({
          path: file.path,
          status: file.status,
          original: file.status === 'added' || file.status === 'untracked' ? null : r.original,
          modified: file.status === 'deleted' ? null : r.modified,
          languageId: languageIdFor(file.path),
          ...(file.binary ? { binary: true } : {}),
        });
      });
    return () => {
      alive = false;
    };
  }, [file, task.id, range.from, range.to, tick]);

  if (!run.worktree?.baseCommit)
    return (
      <EmptyState
        className="h-full"
        title="No changes to show"
        description={run.status === 'draft' ? 'Start the task first.' : 'This task did not run in a git repository.'}
      />
    );
  return (
    <div className="flex h-full min-h-0" data-testid="ensemble-changes">
      <div className="flex w-72 flex-none flex-col border-r border-line-subtle">
        <div className="flex flex-none items-center gap-1 border-b border-line-subtle p-2">
          <select
            aria-label="Changes of"
            value={rangeIndex}
            onChange={(e) => {
              setRangeIndex(Number(e.target.value));
              setSelected(null);
            }}
            className={cn(inputSized, 'min-w-0 flex-1')}
          >
            {ranges.map((r, i) => (
              <option key={i} value={i}>
                {r.label}
              </option>
            ))}
          </select>
          <IconButton label="Refresh" icon={<RefreshCw size={13} />} onClick={() => setTick((n) => n + 1)} />
        </div>
        <div role="listbox" aria-label="Changed files" className="min-h-0 flex-1 overflow-auto p-1">
          {files === null && <div className="p-2 text-small text-fg-muted">Loading…</div>}
          {files?.length === 0 && <div className="p-2 text-small text-fg-muted">No changes.</div>}
          {files?.map((f) => (
            <button
              key={f.path}
              type="button"
              role="option"
              aria-selected={selected === f.path}
              data-testid="ensemble-change"
              onClick={() => setSelected(f.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-badge px-2 py-0.5 text-left',
                selected === f.path ? 'bg-focus-tint' : 'hover:bg-card-hover',
              )}
            >
              <span className={cn('w-3 flex-none font-mono text-[11px]', STATUS_TEXT_CLASS[f.status])}>
                {STATUS_LETTERS[f.status]}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-fg" title={f.path}>
                {f.path}
              </span>
              {f.additions !== undefined && (
                <span className="font-mono text-[10px] text-git-added">+{f.additions}</span>
              )}
              {f.deletions !== undefined && (
                <span className="font-mono text-[10px] text-git-deleted">−{f.deletions}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-none border-t border-line-subtle p-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void ipc.invoke('ensemble:openFolder', { taskId: task.id, target: 'editor' })}
          >
            <FolderOpen size={12} /> Open the worktree in the editor
          </Button>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {!diff || diff.path !== selected ? (
          <EmptyState
            className="h-full"
            title="Select a file"
            description="Its diff against the base (or the previous checkpoint) opens here."
          />
        ) : diff.binary ? (
          <EmptyState className="h-full" title="Binary file" />
        ) : (
          <Suspense fallback={null}>
            <DiffEditorView
              panelId={`ensemble-${task.id}`}
              content={diff}
              options={{
                sideBySide: settings?.['git.diff.sideBySide'] ?? true,
                ignoreWhitespace: settings?.['git.diff.ignoreWhitespace'] ?? false,
                hideUnchanged: settings?.['git.diff.hideUnchangedRegions'] ?? true,
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
