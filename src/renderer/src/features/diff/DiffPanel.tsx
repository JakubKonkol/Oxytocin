import type { IDockviewPanelProps } from 'dockview-react';
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  ExternalLink,
  FileCode2,
  FoldVertical,
  ListChecks,
  Rows2,
  Save,
  Sparkles,
  Undo2,
  WholeWord,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffContent } from '@shared/domain/git';
import { OxyError } from '@shared/errors';
import { cn } from '../../lib/cn';
import { useLatest } from '../../lib/use-latest';
import { ipc } from '../../lib/ipc-client';
import { useChangesStore } from '../../stores/changes-store';
import { useProjectsStore } from '../../stores/projects-store';
import { useSettingsStore } from '../../stores/settings-store';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { Button } from '../../ui/Button';
import { absolutePath, openInEditor } from '../changes/change-actions';
import { discardFiles, stageState, toggleStaged } from '../changes/git-actions';
import { STATUS_LABELS, STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { askAgent } from '../ask-agent/ask-agent-store';
import { openFile } from '../editor/editor-actions';
import { unsavedRegistry } from '../layout/unsaved-registry';
import { openReview } from '../review/review-actions';
import { confirmDialog } from '../../stores/dialog-store';
import { notify } from '../../ui/Toast';
import { type DiffPanelParams, pinDiff } from './diff-actions';
import { diffRegistry } from './diff-registry';
import type { DiffViewOptions } from './DiffEditorView';

const DiffEditorView = lazy(() => import('./DiffEditorView'));

const LIVE_DEBOUNCE_MS = 300;

const formatBytes = (n: number | null) =>
  n === null
    ? '—'
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;

function Toggle({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return <IconButton label={label} icon={icon} active={active} aria-pressed={active} onClick={onClick} />;
}

/** Center panel with the diff of one file against HEAD. */
export function DiffPanelComponent(props: IDockviewPanelProps<DiffPanelParams>) {
  const { projectId, path, oldPath } = props.params;
  const panelId = props.api.id;
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useSettingsStore((s) => s.settings);
  const [options, setOptions] = useState<DiffViewOptions>(() => ({
    sideBySide: settings?.['git.diff.sideBySide'] ?? true,
    ignoreWhitespace: settings?.['git.diff.ignoreWhitespace'] ?? false,
    hideUnchanged: settings?.['git.diff.hideUnchangedRegions'] ?? true,
  }));
  const [content, setContent] = useState<FileDiffContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const loadSeq = useRef(0);
  const dirtyRef = useLatest(dirty);
  const contentRef = useLatest(content);

  // Fingerprint of the file in the latest status + live touches: a change means the content changed.
  const fingerprint = useChangesStore((s) => {
    const f = s.status[projectId]?.files.find((x) => x.path === path);
    const touched = s.touched[projectId]?.[path] ?? 0;
    return `${f?.status}:${f?.additions}:${f?.deletions}:${f?.touchedAt ?? 0}:${touched}`;
  });
  const file = useChangesStore((s) => s.status[projectId]?.files.find((x) => x.path === path));

  const load = useCallback(
    async (live: boolean) => {
      const seq = ++loadSeq.current;
      try {
        const next = await ipc.invoke('git:getFileDiff', { projectId, path, ...(oldPath ? { oldPath } : {}) });
        if (seq !== loadSeq.current) return;
        // Unsaved edits stay on screen; the newer version waits for "Reload".
        if (live && dirtyRef.current && next.modified !== contentRef.current?.modified) setDiskChanged(true);
        setContent(next);
        setError(null);
        if (live) setUpdatedAt(Date.now());
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId, path, oldPath, dirtyRef, contentRef],
  );

  useEffect(() => {
    // The state updates happen after the IPC round trip, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false);
  }, [load]);

  const firstFingerprint = useRef(fingerprint);
  useEffect(() => {
    if (fingerprint === firstFingerprint.current) return;
    firstFingerprint.current = fingerprint;
    const timer = setTimeout(() => void load(true), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fingerprint, load]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (updatedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [updatedAt]);

  useEffect(() => {
    props.api.setTitle(`${dirty ? '● ' : ''}${path.split('/').at(-1) ?? path}`);
  }, [props.api, path, dirty]);

  const status = content?.status ?? file?.status;
  const editable = !!content && content.modified !== null && !content.binary && !content.tooLarge;

  const save = useCallback(
    (force = false): Promise<boolean> => {
      const attempt = async (force: boolean): Promise<boolean> => {
        const text = diffRegistry.get(panelId)?.modifiedValue();
        const current = contentRef.current;
        if (text == null || !current) return false;
        try {
          await ipc.invoke('files:write', {
            projectId,
            path,
            content: text,
            ...(current.bom ? { bom: true } : {}),
            ...(!force && current.mtimeMs !== undefined && !diskChanged ? { expectedMtimeMs: current.mtimeMs } : {}),
          });
          diffRegistry.get(panelId)?.markSaved();
          setDiskChanged(false);
          return true;
        } catch (e) {
          if (e instanceof OxyError && e.code === 'CONFLICT') {
            const ok = await confirmDialog({
              title: `${path.split('/').at(-1)} changed on disk`,
              description:
                'The file changed after the diff was loaded (an agent may be editing it). Overwrite it with your version?',
              confirmLabel: 'Overwrite',
              tone: 'warning',
            });
            return ok ? attempt(true) : false;
          }
          notify('error', 'Could not save the file', { description: e instanceof Error ? e.message : String(e) });
          return false;
        }
      };
      return attempt(force);
    },
    [panelId, projectId, path, diskChanged, contentRef],
  );

  useEffect(() => {
    unsavedRegistry.set(panelId, { name: path.split('/').at(-1) ?? path, isDirty: () => dirtyRef.current, save });
    return () => {
      unsavedRegistry.delete(panelId);
    };
  }, [panelId, path, save, dirtyRef]);

  useEffect(() => {
    if (dirty) pinDiff(props.containerApi, panelId);
  }, [dirty, props.containerApi, panelId]);
  const openEditor = () => {
    if (!project) return;
    const line = diffRegistry.get(panelId)?.currentLine();
    void ipc.invoke('editor:open', { path: absolutePath(project, path), ...(line ? { line } : {}) });
  };
  const toggle = (key: keyof DiffViewOptions) => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const banner = useMemo(() => {
    if (!content) return null;
    if (content.status === 'deleted') return 'File deleted';
    if (content.original === null && content.modified !== null && !content.binary && !content.tooLarge)
      return 'New file';
    return null;
  }, [content]);

  let body: React.ReactNode;
  if (error) body = <EmptyState title="Could not read the file" description={error} />;
  else if (!content) body = <EmptyState title="Loading diff…" />;
  else if (content.binary)
    body = (
      <EmptyState
        title="Binary file — diff not available"
        description={`HEAD: ${formatBytes(content.sizes?.original ?? null)} · now: ${formatBytes(content.sizes?.modified ?? null)}`}
      />
    );
  else if (content.tooLarge)
    body = (
      <EmptyState
        title="File too large to diff"
        description={`${formatBytes(content.tooLarge.sizeBytes)} — the limit is git.diff.maxFileSizeMb.`}
        actions={
          project && status !== 'deleted' ? (
            <Button variant="secondary" onClick={() => void openInEditor(project, path)}>
              Open in editor
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <Suspense fallback={<EmptyState title="Loading editor…" />}>
        <DiffEditorView
          panelId={panelId}
          projectId={projectId}
          content={content}
          options={options}
          editable={editable}
          onDirtyChange={setDirty}
          onSave={() => void save()}
        />
      </Suspense>
    );

  return (
    <div
      data-testid="diff-panel"
      data-path={path}
      data-keycontext="diff"
      className="flex h-full min-h-0 flex-col bg-card"
      onPointerDownCapture={() => {
        if (!props.api.isActive) props.api.setActive();
      }}
    >
      <div className="flex h-8 flex-none items-center gap-2 border-b border-line-subtle px-2 text-small">
        <span
          className="min-w-0 truncate font-mono text-fg-secondary"
          title={oldPath ? `${path}\nfrom: ${oldPath}` : path}
        >
          {oldPath ? `${oldPath} → ` : ''}
          {path}
        </span>
        {status && (
          <span
            title={STATUS_LABELS[status]}
            data-testid="diff-status"
            className={cn('font-mono font-semibold', STATUS_TEXT_CLASS[status])}
          >
            {STATUS_LETTERS[status]}
          </span>
        )}
        {file && (file.additions !== undefined || file.deletions !== undefined) && (
          <span className="font-mono">
            <span className="text-git-added">+{file.additions ?? 0}</span>{' '}
            <span className="text-git-deleted">−{file.deletions ?? 0}</span>
          </span>
        )}
        {banner && (
          <span data-testid="diff-banner" className="rounded-badge bg-input px-1.5 text-fg-muted">
            {banner}
          </span>
        )}
        {updatedAt !== null && (
          <span data-testid="diff-updated" className="text-fg-muted">
            updated{' '}
            {Math.max(0, Math.round((now - updatedAt) / 1000)) < 5
              ? 'just now'
              : `${Math.round((now - updatedAt) / 1000)}s ago`}
          </span>
        )}
        {dirty && (
          <span title="Unsaved edits" data-testid="diff-dirty" className="size-2 flex-none rounded-full bg-accent" />
        )}
        <span className="flex-1" />
        {dirty && (
          <IconButton
            data-testid="diff-save"
            label="Save"
            shortcut="Ctrl+S"
            icon={<Save size={13} />}
            onClick={() => void save()}
          />
        )}
        {file && (
          <label
            className="flex h-6 flex-none cursor-default items-center gap-1 rounded-control px-1.5 text-fg-secondary hover:bg-card-hover"
            title="Staged for the next commit"
          >
            <input
              type="checkbox"
              data-testid="diff-stage"
              checked={stageState([file]) === 'all'}
              ref={(el) => {
                if (el) el.indeterminate = stageState([file]) === 'some';
              }}
              onChange={() => void toggleStaged(projectId, [file])}
              className="accent-(--accent)"
            />
            Staged
          </label>
        )}
        <IconButton
          data-testid="diff-discard"
          label="Discard changes"
          icon={<Undo2 size={13} />}
          disabled={!file}
          onClick={() => file && void discardFiles(projectId, [file])}
        />
        <IconButton
          data-testid="diff-ask-agent"
          label="Ask agent about these changes (select code to ask about it: Ctrl+L)"
          icon={<Sparkles size={13} />}
          onClick={() => askAgent({ projectId, contexts: [{ kind: 'changes', changes: { path } }] })}
        />
        <IconButton
          label="Review all changes"
          icon={<ListChecks size={13} />}
          onClick={() => void openReview(projectId, path)}
        />
        <span className="mx-0.5 h-4 w-px bg-line-subtle" />
        <IconButton
          label="Previous change"
          shortcut="Shift+F7"
          icon={<ArrowUp size={13} />}
          onClick={() => diffRegistry.get(panelId)?.goToChange('previous')}
        />
        <IconButton
          label="Next change"
          shortcut="F7"
          icon={<ArrowDown size={13} />}
          onClick={() => diffRegistry.get(panelId)?.goToChange('next')}
        />
        <Toggle
          label={options.sideBySide ? 'Inline view' : 'Side-by-side view'}
          active={!options.sideBySide}
          icon={options.sideBySide ? <Rows2 size={13} /> : <Columns2 size={13} />}
          onClick={() => toggle('sideBySide')}
        />
        <Toggle
          label="Ignore whitespace"
          active={options.ignoreWhitespace}
          icon={<WholeWord size={13} />}
          onClick={() => toggle('ignoreWhitespace')}
        />
        <Toggle
          label="Collapse unchanged regions"
          active={options.hideUnchanged}
          icon={<FoldVertical size={13} />}
          onClick={() => toggle('hideUnchanged')}
        />
        <IconButton
          data-testid="diff-open-file"
          label="Open file"
          icon={<FileCode2 size={13} />}
          disabled={status === 'deleted'}
          onClick={() => {
            const line = diffRegistry.get(panelId)?.currentLine();
            openFile(projectId, path, { pinned: true, ...(line ? { line } : {}) });
          }}
        />
        <IconButton
          label="Open in external editor"
          icon={<ExternalLink size={13} />}
          disabled={status === 'deleted'}
          onClick={openEditor}
        />
      </div>
      {diskChanged && (
        <div
          data-testid="diff-disk-banner"
          className="flex flex-none items-center gap-2 border-b border-line-subtle bg-warning/10 px-3 py-1.5 text-small text-warning"
        >
          <span className="flex-1">The file changed on disk while you were editing it.</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              diffRegistry.get(panelId)?.discardEdits();
              setDiskChanged(false);
            }}
          >
            Reload (discard my edits)
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(true)}>
            Save mine
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}
