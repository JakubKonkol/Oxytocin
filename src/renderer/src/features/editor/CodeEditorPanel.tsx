import type { IDockviewPanelProps } from 'dockview-react';
import { ExternalLink, FolderTree, GitCompare, Map as MapIcon, Save, Sparkles, WrapText } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FileContent } from '@shared/domain/files';
import { OxyError } from '@shared/errors';
import { cn } from '../../lib/cn';
import { useLatest } from '../../lib/use-latest';
import { ipc } from '../../lib/ipc-client';
import { useChangesStore } from '../../stores/changes-store';
import { confirmDialog } from '../../stores/dialog-store';
import { useProjectsStore } from '../../stores/projects-store';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { askAgent } from '../ask-agent/ask-agent-store';
import { openInEditor } from '../changes/change-actions';
import { STATUS_LABELS, STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { openDiff } from '../diff/diff-actions';
import { unsavedRegistry } from '../layout/unsaved-registry';
import { codeRegistry } from './code-registry';
import type { CodeViewApi, CodeViewOptions } from './CodeEditorView';
import { type CodePanelParams, pendingReveal, pinCodePanel } from './editor-actions';
import { revealInFiles } from './files-store';

const CodeEditorView = lazy(() => import('./CodeEditorView'));

const fileName = (path: string) => path.split('/').at(-1) ?? path;

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <span className="flex min-w-0 items-center gap-1 truncate font-mono" title={path}>
      {parts.map((part, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-fg-muted">/</span>}
          <span className={i === parts.length - 1 ? 'text-fg' : 'text-fg-muted'}>{part}</span>
        </span>
      ))}
    </span>
  );
}

/** Center panel: a project file in the built-in code editor (view, edit, save). A preview tab shows another file
 * by changing its params: the editor starts over for it. */
export function CodeEditorPanel(props: IDockviewPanelProps<CodePanelParams>) {
  return <CodeEditor key={props.params.path} {...props} />;
}

function CodeEditor(props: IDockviewPanelProps<CodePanelParams>) {
  const { projectId, path } = props.params;
  const panelId = props.api.id;
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const settings = useSettingsStore((s) => s.settings);
  const [options, setOptions] = useState<CodeViewOptions>(() => ({
    fontSize: settings?.['editor.code.fontSize'] ?? 13,
    wordWrap: settings?.['editor.code.wordWrap'] ?? false,
    minimap: settings?.['editor.code.minimap'] ?? true,
  }));
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [disk, setDisk] = useState<'same' | 'changed' | 'deleted'>('same');
  const [saving, setSaving] = useState(false);
  const viewApi = useRef<CodeViewApi | null>(null);
  const mtime = useRef<number | null>(null);
  const dirtyRef = useLatest(dirty);
  const contentRef = useLatest(content);
  const change = useChangesStore((s) => s.status[projectId]?.files.find((f) => f.path === path));
  const touched = useChangesStore((s) => s.touched[projectId]?.[path] ?? 0);

  /** Reads the file; with `intoView`, an editor that is already open shows the new text. */
  const load = useCallback(
    async (intoView: boolean) => {
      try {
        const next = await ipc.invoke('files:read', { projectId, path });
        mtime.current = next.mtimeMs;
        setDisk('same');
        setError(null);
        if (intoView && viewApi.current && next.content !== null) viewApi.current.load(next.content);
        else setContent(next);
      } catch (e) {
        if (e instanceof OxyError && e.code === 'NOT_FOUND' && contentRef.current) setDisk('deleted');
        else setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId, path, contentRef],
  );

  useEffect(() => {
    // The state updates happen after the IPC round trip.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false);
  }, [load]);

  /** Compares the file on disk with the version in the editor (after a write by an agent, on focus). */
  const checkDisk = useCallback(async () => {
    if (mtime.current === null) return;
    const s = await ipc.invoke('files:stat', { projectId, path }).catch(() => null);
    if (!s) {
      setDisk('deleted');
      return;
    }
    if (Math.abs(s.mtimeMs - mtime.current) <= 1) return;
    if (dirtyRef.current) setDisk('changed');
    else await load(true);
  }, [projectId, path, load, dirtyRef]);

  useEffect(() => {
    if (!touched) return;
    const timer = setTimeout(() => void checkDisk(), 250);
    return () => clearTimeout(timer);
  }, [touched, checkDisk]);

  useEffect(() => {
    const onFocus = () => void checkDisk();
    window.addEventListener('focus', onFocus);
    const sub = props.api.onDidActiveChange((e) => {
      if (e.isActive) void checkDisk();
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      sub.dispose();
    };
  }, [checkDisk, props.api]);

  const save = useCallback(
    (force = false): Promise<boolean> => {
      const attempt = async (force: boolean): Promise<boolean> => {
        const text = viewApi.current?.getValue();
        if (text === undefined || !contentRef.current) return false;
        setSaving(true);
        try {
          const stat = await ipc.invoke('files:write', {
            projectId,
            path,
            content: text,
            ...(contentRef.current.bom ? { bom: true } : {}),
            ...(!force && mtime.current !== null && disk !== 'deleted' ? { expectedMtimeMs: mtime.current } : {}),
          });
          mtime.current = stat.mtimeMs;
          viewApi.current?.markSaved();
          setDisk('same');
          return true;
        } catch (e) {
          if (e instanceof OxyError && e.code === 'CONFLICT') {
            const overwrite = await confirmDialog({
              title: `${fileName(path)} changed on disk`,
              description:
                'Someone (an agent?) changed the file after you opened it. Overwrite their version with yours, or cancel and reload it from the banner.',
              confirmLabel: 'Overwrite',
              tone: 'warning',
            });
            setDisk('changed');
            return overwrite ? await attempt(true) : false;
          }
          notify('error', `Could not save ${fileName(path)}`, {
            description: e instanceof Error ? e.message : String(e),
          });
          return false;
        } finally {
          setSaving(false);
        }
      };
      return attempt(force);
    },
    [projectId, path, disk, contentRef],
  );

  useEffect(() => {
    props.api.setTitle(`${dirty ? '● ' : ''}${fileName(path)}`);
    if (dirty) pinCodePanel(props.containerApi, panelId);
  }, [props.api, props.containerApi, panelId, path, dirty]);

  useEffect(() => {
    codeRegistry.set(panelId, {
      projectId,
      path,
      isDirty: () => dirtyRef.current,
      save: () => save(),
      text: () => viewApi.current?.getValue() ?? null,
      setText: (text) => viewApi.current?.load(text),
      revealLine: (line, column) => viewApi.current?.revealLine(line, column),
      revealInFiles: () => revealInFiles(projectId, path),
      focus: () => viewApi.current?.focus(),
    });
    unsavedRegistry.set(panelId, {
      projectId,
      name: fileName(path),
      isDirty: () => dirtyRef.current,
      save: () => save(),
    });
    return () => {
      codeRegistry.delete(panelId);
      unsavedRegistry.delete(panelId);
    };
  }, [panelId, projectId, path, save, dirtyRef]);

  const onReady = () => {
    const at = pendingReveal.get(panelId);
    if (!at) return;
    pendingReveal.delete(panelId);
    requestAnimationFrame(() => viewApi.current?.revealLine(at.line, at.column));
  };

  const askAboutCode = () => {
    const selection = viewApi.current?.selection();
    askAgent({
      projectId,
      contexts:
        selection && selection.code.trim() && selection.startLine !== selection.endLine
          ? [{ kind: 'code', code: selection }]
          : [{ kind: 'file', path }],
    });
  };
  const toggle = (key: 'wordWrap' | 'minimap') => setOptions((o) => ({ ...o, [key]: !o[key] }));

  let body: React.ReactNode;
  if (error) body = <EmptyState title="Could not open the file" description={error} />;
  else if (!content) body = <EmptyState title="Opening…" />;
  else if (content.content === null)
    body = (
      <EmptyState
        title={content.binary ? 'Binary file' : 'File too large for the built-in editor'}
        description={
          content.binary
            ? 'Binary files cannot be edited here.'
            : `${(content.size / 1048576).toFixed(1)} MB — the limit is editor.code.maxFileSizeMb.`
        }
        actions={
          project ? (
            <Button variant="secondary" onClick={() => void openInEditor(project, path)}>
              Open in external editor
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <Suspense fallback={<EmptyState title="Loading editor…" />}>
        <CodeEditorView
          projectId={projectId}
          path={path}
          languageId={content.languageId}
          initialText={content.content}
          eol={content.eol}
          options={options}
          apiRef={viewApi}
          onDirtyChange={setDirty}
          onSave={() => void save()}
          onReady={onReady}
        />
      </Suspense>
    );

  return (
    <div
      data-testid="code-panel"
      data-path={path}
      data-dirty={dirty}
      data-keycontext="code"
      className="flex h-full min-h-0 flex-col bg-card"
      onPointerDownCapture={() => {
        if (!props.api.isActive) props.api.setActive();
      }}
    >
      <div className="flex h-8 flex-none items-center gap-2 border-b border-line-subtle px-2 text-small">
        <Breadcrumb path={path} />
        {dirty && (
          <span title="Unsaved changes" data-testid="code-dirty" className="size-2 flex-none rounded-full bg-accent" />
        )}
        {change && (
          <button
            type="button"
            title={`${STATUS_LABELS[change.status]} — open the diff`}
            onClick={() => openDiff(projectId, change, { pinned: true })}
            className="flex flex-none items-center gap-1 rounded-badge px-1 hover:bg-card-hover"
          >
            <span className={cn('font-mono font-semibold', STATUS_TEXT_CLASS[change.status])}>
              {STATUS_LETTERS[change.status]}
            </span>
            {(change.additions !== undefined || change.deletions !== undefined) && (
              <span className="font-mono">
                <span className="text-git-added">+{change.additions ?? 0}</span>{' '}
                <span className="text-git-deleted">−{change.deletions ?? 0}</span>
              </span>
            )}
          </button>
        )}
        <span className="flex-1" />
        {content?.content !== null && content && (
          <span className="flex-none text-fg-muted">
            {content.languageId}
            {content.eol ? ` · ${content.eol.toUpperCase()}` : ''}
          </span>
        )}
        <IconButton
          data-testid="code-ask-agent"
          label="Ask agent (selection or file)"
          shortcut="Ctrl+L"
          icon={<Sparkles size={13} />}
          onClick={askAboutCode}
        />
        <IconButton
          data-testid="code-save"
          label="Save"
          shortcut="Ctrl+S"
          icon={<Save size={13} />}
          disabled={!dirty || saving}
          onClick={() => void save()}
        />
        {change && (
          <IconButton
            label="Open diff"
            icon={<GitCompare size={13} />}
            onClick={() => openDiff(projectId, change, { pinned: true })}
          />
        )}
        <IconButton
          label="Word wrap"
          icon={<WrapText size={13} />}
          active={options.wordWrap}
          aria-pressed={options.wordWrap}
          onClick={() => toggle('wordWrap')}
        />
        <IconButton
          label="Minimap"
          icon={<MapIcon size={13} />}
          active={options.minimap}
          aria-pressed={options.minimap}
          onClick={() => toggle('minimap')}
        />
        <IconButton
          label="Reveal in FILES"
          icon={<FolderTree size={13} />}
          onClick={() => revealInFiles(projectId, path)}
        />
        <IconButton
          label="Open in external editor"
          icon={<ExternalLink size={13} />}
          disabled={!project}
          onClick={() => project && void openInEditor(project, path)}
        />
      </div>
      {disk !== 'same' && (
        <div
          data-testid="code-disk-banner"
          className="flex flex-none items-center gap-2 border-b border-line-subtle bg-warning/10 px-3 py-1.5 text-small text-warning"
        >
          <span className="flex-1">
            {disk === 'deleted'
              ? 'The file was deleted on disk. Saving creates it again.'
              : 'The file changed on disk while you were editing it.'}
          </span>
          {disk === 'changed' && (
            <Button size="sm" variant="secondary" data-testid="code-reload" onClick={() => void load(true)}>
              Reload (discard my edits)
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid="code-keep-mine"
            onClick={() =>
              void ipc.invoke('files:stat', { projectId, path }).then((s) => {
                // The next save writes over the version on disk without asking again.
                if (s) mtime.current = s.mtimeMs;
                setDisk('same');
              })
            }
          >
            Keep mine
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}
