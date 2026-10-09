import type { IDockviewPanelProps } from 'dockview-react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Eye,
  FileCode2,
  FoldVertical,
  GitCompare,
  ListChecks,
  MessageSquare,
  Rows2,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  WholeWord,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, FileDiffContent } from '@shared/domain/git';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { useChangesStore } from '../../stores/changes-store';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { askAgent } from '../ask-agent/ask-agent-store';
import { lineRange, PROMPT_PRESETS, presetInstruction, reviewPrompt } from '../ask-agent/prompt-model';
import { discardFiles, stageState, toggleStaged } from '../changes/git-actions';
import { STATUS_LABELS, STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { openDiff } from '../diff/diff-actions';
import type { DiffViewOptions } from '../diff/DiffEditorView';
import { openFile } from '../editor/editor-actions';
import { changeFingerprint, useReviewFocus } from './review-actions';
import { useComments, useReviewStore } from './review-store';

const DiffEditorView = lazy(() => import('../diff/DiffEditorView'));

/** Files rendered at most (the rest are listed with a hint to commit or narrow the change). */
const MAX_FILES = 300;
const LINE_HEIGHT = 19;

const EMPTY_FILES: FileChange[] = [];

function estimateHeight(f: FileChange): number {
  const lines = (f.additions ?? 0) + (f.deletions ?? 0);
  return Math.min(Math.max(lines, 3) + 6, 40) * LINE_HEIGHT;
}

/** Mounts children only while the element is near the viewport (Monaco editors are heavy). */
function useNearViewport(root: HTMLElement | null, el: HTMLElement | null): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      root,
      rootMargin: '1200px 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, el]);
  return near;
}

function FileDiffBody({
  projectId,
  file,
  options,
  scrollRoot,
}: {
  projectId: string;
  file: FileChange;
  options: DiffViewOptions;
  scrollRoot: HTMLElement | null;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const near = useNearViewport(scrollRoot, el);
  const [content, setContent] = useState<FileDiffContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(() => estimateHeight(file));
  const fingerprint = useChangesStore((s) => {
    const touched = s.touched[projectId]?.[file.path] ?? 0;
    return `${changeFingerprint(file)}:${file.touchedAt ?? 0}:${touched}`;
  });

  useEffect(() => {
    if (!near) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        void ipc
          .invoke('git:getFileDiff', { projectId, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) })
          .then(
            (c) => alive && (setContent(c), setError(null)),
            (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
          ),
      content ? 300 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // Reloads when the file changes (fingerprint) or comes into view; `content` only picks the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, fingerprint, projectId, file.path, file.oldPath]);

  let body: React.ReactNode;
  if (error) body = <div className="px-3 py-2 text-small text-danger">{error}</div>;
  else if (content?.binary) body = <div className="px-3 py-2 text-small text-fg-muted">Binary file — no diff</div>;
  else if (content?.tooLarge)
    body = <div className="px-3 py-2 text-small text-fg-muted">File too large to diff (git.diff.maxFileSizeMb)</div>;
  else if (near && content)
    body = (
      <div style={{ height }}>
        <Suspense fallback={null}>
          <DiffEditorView
            panelId={`review:${projectId}:${file.path}`}
            projectId={projectId}
            content={content}
            options={options}
            autoHeight={setHeight}
          />
        </Suspense>
      </div>
    );
  else body = <div style={{ height }} />;
  return (
    <div ref={setEl} data-testid="review-file-body">
      {body}
    </div>
  );
}

function FileSection({
  projectId,
  file,
  viewed,
  collapsed,
  commentCount,
  options,
  scrollRoot,
  onToggle,
  onViewed,
  registerEl,
}: {
  projectId: string;
  file: FileChange;
  viewed: boolean;
  collapsed: boolean;
  commentCount: number;
  options: DiffViewOptions;
  scrollRoot: HTMLElement | null;
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  registerEl: (el: HTMLElement | null) => void;
}) {
  const deleted = file.status === 'deleted';
  const stage = stageState([file]);
  return (
    <section
      ref={registerEl}
      data-testid="review-file"
      data-path={file.path}
      className="overflow-hidden rounded-card border border-line-subtle bg-card"
    >
      <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line-subtle bg-card px-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {collapsed ? (
            <ChevronRight size={14} className="flex-none text-fg-muted" />
          ) : (
            <ChevronDown size={14} className="flex-none text-fg-muted" />
          )}
          <span
            title={STATUS_LABELS[file.status]}
            className={cn(
              'w-3 flex-none text-center font-mono text-small font-semibold',
              STATUS_TEXT_CLASS[file.status],
            )}
          >
            {STATUS_LETTERS[file.status]}
          </span>
          <span className={cn('min-w-0 truncate font-mono text-ui text-fg', deleted && 'text-fg-muted line-through')}>
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {file.path}
          </span>
          <span className="flex-none font-mono text-small">
            {!!file.additions && <span className="text-git-added">+{file.additions}</span>}
            {!!file.deletions && <span className="ml-1 text-git-deleted">−{file.deletions}</span>}
          </span>
          {commentCount > 0 && (
            <span className="flex flex-none items-center gap-0.5 rounded-badge bg-accent-muted px-1 text-small text-fg">
              <MessageSquare size={10} /> {commentCount}
            </span>
          )}
        </button>
        <IconButton
          label="Ask agent about this file's changes"
          icon={<Sparkles size={13} />}
          onClick={() =>
            askAgent({ projectId, contexts: [{ kind: 'changes', changes: { path: file.path } }], presetId: 'review' })
          }
        />
        <IconButton
          label="Open file"
          icon={<FileCode2 size={13} />}
          disabled={deleted}
          onClick={() => openFile(projectId, file.path, { pinned: true })}
        />
        <IconButton
          label="Open diff in a tab"
          icon={<GitCompare size={13} />}
          onClick={() => openDiff(projectId, file, { pinned: true })}
        />
        <IconButton
          label="Discard changes"
          icon={<Undo2 size={13} />}
          onClick={() => void discardFiles(projectId, [file])}
        />
        <label
          className="flex h-6 flex-none cursor-default items-center gap-1 rounded-control px-1.5 text-small text-fg-secondary hover:bg-card-hover"
          title="Staged for the next commit"
        >
          <input
            type="checkbox"
            data-testid="review-stage"
            checked={stage === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = stage === 'some';
            }}
            onChange={() => void toggleStaged(projectId, [file])}
            className="accent-(--accent)"
          />
          Staged
        </label>
        <label
          className={cn(
            'flex h-6 flex-none cursor-default items-center gap-1 rounded-control border px-1.5 text-small',
            viewed
              ? 'border-accent bg-accent-muted text-fg'
              : 'border-line-subtle text-fg-secondary hover:bg-card-hover',
          )}
        >
          <input
            type="checkbox"
            data-testid="review-viewed"
            checked={viewed}
            onChange={(e) => onViewed(e.target.checked)}
            className="accent-(--accent)"
          />
          Viewed
        </label>
      </header>
      {!collapsed && <FileDiffBody projectId={projectId} file={file} options={options} scrollRoot={scrollRoot} />}
    </section>
  );
}

/** A center panel with every changed file's diff, one below the other — for reviewing what an agent did. */
export function ReviewPanel(props: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = props.params;
  const files = useChangesStore((s) => s.status[projectId]?.files ?? EMPTY_FILES);
  const totals = useChangesStore((s) => s.status[projectId]?.totals);
  const viewedMap = useReviewStore((s) => s.viewed[projectId]);
  const comments = useComments(projectId);
  const settings = useSettingsStore((s) => s.settings);
  const [options, setOptions] = useState<DiffViewOptions>(() => ({
    sideBySide: settings?.['git.diff.sideBySide'] ?? true,
    ignoreWhitespace: settings?.['git.diff.ignoreWhitespace'] ?? false,
    hideUnchanged: true,
  }));
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const focus = useReviewFocus((s) => s.focus[projectId]);

  const shown = files.slice(0, MAX_FILES);
  const isViewed = useCallback((f: FileChange) => viewedMap?.[f.path] === changeFingerprint(f), [viewedMap]);
  const viewedCount = shown.filter(isViewed).length;
  const isCollapsed = (f: FileChange) => collapsedOverride[f.path] ?? isViewed(f);
  const commentsByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments]);

  const scrollTo = useCallback((path: string) => {
    setCollapsedOverride((o) => ({ ...o, [path]: false }));
    requestAnimationFrame(() => sectionEls.current.get(path)?.scrollIntoView({ block: 'start' }));
  }, []);

  useEffect(() => {
    // A file asked for from the CHANGES section (openReview with a path).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (focus) scrollTo(focus.path);
  }, [focus, scrollTo]);

  const toggleOption = (key: keyof DiffViewOptions) => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const setAllCollapsed = (collapsed: boolean) =>
    setCollapsedOverride(Object.fromEntries(shown.map((f) => [f.path, collapsed])));

  const sendReview = () =>
    askAgent({
      projectId,
      contexts: [],
      text: reviewPrompt(comments),
      onSent: () => useReviewStore.getState().clear(projectId),
    });
  const askForReview = () => {
    const preset = PROMPT_PRESETS.find((p) => p.id === 'review')!;
    const contexts = shown.slice(0, 50).map((f) => ({ kind: 'changes' as const, changes: { path: f.path } }));
    askAgent({ projectId, contexts, text: presetInstruction(preset, contexts) });
  };

  if (files.length === 0)
    return (
      <div data-testid="review-panel" className="flex h-full items-center justify-center bg-card">
        <EmptyState
          title="Nothing to review"
          description="There are no changes since the last commit."
          className="py-6"
        />
      </div>
    );

  return (
    <div data-testid="review-panel" data-keycontext="review" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-line-subtle bg-card px-2 text-small">
        <ListChecks size={14} className="flex-none text-accent" />
        <span className="font-medium text-fg">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        {totals && (
          <span className="font-mono">
            <span className="text-git-added">+{totals.additions}</span>{' '}
            <span className="text-git-deleted">−{totals.deletions}</span>
          </span>
        )}
        <span className="flex items-center gap-1.5 text-fg-muted" data-testid="review-progress">
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-input">
            <span
              className="block h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${shown.length ? (viewedCount / shown.length) * 100 : 0}%` }}
            />
          </span>
          {viewedCount}/{shown.length} viewed
        </span>
        <span className="flex-1" />
        <IconButton
          label={options.sideBySide ? 'Inline view' : 'Side-by-side view'}
          icon={options.sideBySide ? <Rows2 size={13} /> : <Columns2 size={13} />}
          active={!options.sideBySide}
          onClick={() => toggleOption('sideBySide')}
        />
        <IconButton
          label="Ignore whitespace"
          icon={<WholeWord size={13} />}
          active={options.ignoreWhitespace}
          onClick={() => toggleOption('ignoreWhitespace')}
        />
        <IconButton
          label="Collapse unchanged regions"
          icon={<FoldVertical size={13} />}
          active={options.hideUnchanged}
          onClick={() => toggleOption('hideUnchanged')}
        />
        <IconButton
          label="Expand all files"
          icon={<ChevronsUpDown size={13} />}
          onClick={() => setAllCollapsed(false)}
        />
        <IconButton
          label="Collapse all files"
          icon={<ChevronsDownUp size={13} />}
          onClick={() => setAllCollapsed(true)}
        />
        <span className="mx-1 h-4 w-px bg-line-subtle" />
        <Button size="sm" variant="secondary" data-testid="review-ask-agent" onClick={askForReview}>
          <Sparkles size={12} className="text-agent" /> Ask agent to review
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="review-send"
          disabled={comments.length === 0}
          onClick={sendReview}
        >
          <Send size={12} /> Send {comments.length || ''} comment{comments.length === 1 ? '' : 's'}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 flex-none flex-col border-r border-line-subtle bg-card">
          <div className="oxy-label px-3 pt-2 pb-1">Files</div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2" data-testid="review-file-list">
            {shown.map((f) => (
              <button
                key={f.path}
                type="button"
                title={f.path}
                onClick={() => scrollTo(f.path)}
                className="flex h-6 w-full items-center gap-1.5 rounded-badge px-1.5 text-left text-ui hover:bg-card-hover"
              >
                {isViewed(f) ? (
                  <Eye size={12} className="flex-none text-accent" />
                ) : (
                  <span
                    className={cn(
                      'w-3 flex-none text-center font-mono text-small font-semibold',
                      STATUS_TEXT_CLASS[f.status],
                    )}
                  >
                    {STATUS_LETTERS[f.status]}
                  </span>
                )}
                <span className={cn('min-w-0 flex-1 truncate', isViewed(f) ? 'text-fg-muted' : 'text-fg')}>
                  {f.path.split('/').at(-1)}
                </span>
                {commentsByPath.get(f.path) && (
                  <span className="flex flex-none items-center gap-0.5 text-small text-accent">
                    <MessageSquare size={10} />
                    {commentsByPath.get(f.path)}
                  </span>
                )}
              </button>
            ))}
            {files.length > shown.length && (
              <div className="px-1.5 py-1 text-small text-fg-muted">
                {files.length - shown.length} more files are not shown.
              </div>
            )}
          </div>
          <div className="flex max-h-[45%] min-h-0 flex-col border-t border-line-subtle">
            <div className="flex items-center gap-1 px-3 pt-2 pb-1">
              <span className="oxy-label flex-1">Comments {comments.length > 0 ? comments.length : ''}</span>
              {comments.length > 0 && (
                <IconButton
                  label="Delete all comments"
                  icon={<Trash2 size={12} />}
                  onClick={() => useReviewStore.getState().clear(projectId)}
                />
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2" data-testid="review-comments">
              {comments.length === 0 ? (
                <div className="px-1.5 text-small leading-relaxed text-fg-muted">
                  Select code in a diff and choose <span className="text-fg-secondary">+ Comment</span> (Ctrl+Alt+M).
                  Comments go to an agent together.
                </div>
              ) : (
                comments.map((c) => (
                  <div
                    key={c.id}
                    data-testid="review-comment"
                    className="group/comment mb-1 rounded-control border border-line-subtle bg-surface px-2 py-1.5"
                  >
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => scrollTo(c.path)}
                        className="min-w-0 flex-1 truncate text-left font-mono text-small text-fg-secondary hover:text-fg"
                      >
                        {c.path.split('/').at(-1)} · {lineRange(c.startLine, c.endLine)}
                      </button>
                      <IconButton
                        label="Delete comment"
                        icon={<Trash2 size={11} />}
                        className="size-5 opacity-0 group-hover/comment:opacity-100"
                        onClick={() => useReviewStore.getState().remove(projectId, c.id)}
                      />
                    </div>
                    <div className="text-small leading-snug whitespace-pre-wrap text-fg">{c.text}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
        <div ref={setScrollRoot} className="min-h-0 flex-1 overflow-auto p-2" data-testid="review-scroll">
          <div className="flex flex-col gap-2">
            {shown.map((f) => (
              <FileSection
                key={f.path}
                projectId={projectId}
                file={f}
                viewed={isViewed(f)}
                collapsed={isCollapsed(f)}
                commentCount={commentsByPath.get(f.path) ?? 0}
                options={options}
                scrollRoot={scrollRoot}
                onToggle={() => setCollapsedOverride((o) => ({ ...o, [f.path]: !isCollapsed(f) }))}
                onViewed={(viewed) => {
                  useReviewStore.getState().setViewed(projectId, f.path, viewed ? changeFingerprint(f) : null);
                  setCollapsedOverride((o) => {
                    const { [f.path]: _drop, ...rest } = o;
                    return rest;
                  });
                }}
                registerEl={(el) => {
                  if (el) sectionEls.current.set(f.path, el);
                  else sectionEls.current.delete(f.path);
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
