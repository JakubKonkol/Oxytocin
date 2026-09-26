import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  File,
  Folder,
  GitBranch,
  List,
  ListTree,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChangeStatus, RepoStatus } from '@shared/domain/git';
import type { Project } from '@shared/domain/project';
import { cn } from '../../lib/cn';
import { currentPlatform } from '../../lib/platform';
import { changesUi, LIVE_MS, useChangesStore } from '../../stores/changes-store';
import { activeProject, useProjectsStore } from '../../stores/projects-store';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { SectionBody } from '../../ui/Section';
import { SplitBar } from '../../ui/SplitBar';
import { absolutePath, copyText, openInEditor, refreshChanges, revealInFolder } from './change-actions';
import { openDiff, openDiffInNewGroup } from '../diff/diff-actions';
import { fileOpenersFor, openWithOpener } from '../plugins/plugin-commands';
import {
  allDirPaths,
  buildTree,
  type FileNode,
  flattenList,
  flattenTree,
  parentRowIndex,
  type Row,
  STATUS_LABELS,
  STATUS_LETTERS,
  STATUS_TEXT_CLASS,
} from './tree-model';

const ROW_HEIGHT = 24;
const DEFAULT_EXPAND_LIMIT = 50;

const STATUS_BG: Record<ChangeStatus, string> = {
  added: 'bg-git-added',
  modified: 'bg-git-modified',
  deleted: 'bg-git-deleted',
  renamed: 'bg-git-renamed',
  untracked: 'bg-git-untracked',
  conflicted: 'bg-git-conflict',
  typechange: 'bg-git-modified',
};

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';

const useActiveProjectId = () => useProjectsStore((s) => s.activeId);

/** A clock that ticks every second until `latest` + the live window has passed (highlights fade out). */
function useLiveNow(latest: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!latest) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t - latest > LIVE_MS) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [latest]);
  return now;
}

function RelativeAge({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatAge(now - at)}</>;
}

export function ChangesCount() {
  const id = useActiveProjectId();
  const count = useChangesStore((s) => (id ? s.status[id]?.totals.files : undefined));
  return count ? <>{count}</> : null;
}

export function ChangesHeaderActions() {
  const id = useActiveProjectId();
  const mode = useChangesStore((s) => (id ? (s.ui[id]?.mode ?? 'tree') : 'tree'));
  if (!id) return null;
  const setUi = useChangesStore.getState().setUi;
  return (
    <>
      <IconButton label="Filter" icon={<Search size={13} />} onClick={() => setUi(id, { filterOpen: true })} />
      <IconButton
        label={mode === 'tree' ? 'View as list' : 'View as tree'}
        icon={mode === 'tree' ? <List size={13} /> : <ListTree size={13} />}
        onClick={() => setUi(id, { mode: mode === 'tree' ? 'list' : 'tree' })}
      />
      <IconButton
        label="Collapse all"
        icon={<ChevronsDownUp size={13} />}
        onClick={() => setUi(id, { expanded: [] })}
      />
      <IconButton label="Refresh" icon={<RotateCw size={13} />} onClick={() => refreshChanges(id)} />
    </>
  );
}

function BranchSummary({ status }: { status: RepoStatus }) {
  const b = status.branch;
  const head = b?.detached ? `detached @ ${b.oid?.slice(0, 7) ?? '?'}` : (b?.head ?? 'no branch');
  const tooltip = [
    b?.upstream ? `Upstream: ${b.upstream} (↑${b.ahead} ↓${b.behind})` : 'No upstream',
    status.headCommit
      ? `${status.headCommit.oid.slice(0, 7)} ${status.headCommit.subject} · ${new Date(status.headCommit.date).toLocaleString()}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="flex flex-none flex-col gap-1.5 pt-1.5 pb-2">
      <div className="flex min-w-0 items-center gap-1.5 text-small">
        <GitBranch size={12} className="flex-none text-fg-muted" />
        <span data-testid="changes-branch" className="min-w-0 truncate font-mono text-fg-secondary" title={tooltip}>
          {head}
        </span>
        {b?.upstream && (b.ahead > 0 || b.behind > 0) && (
          <span className="flex-none font-mono text-fg-muted">
            {b.ahead > 0 ? `↑${b.ahead}` : ''}
            {b.behind > 0 ? ` ↓${b.behind}` : ''}
          </span>
        )}
        <span className="flex-1" />
        <span data-testid="changes-totals" className="flex flex-none items-center gap-1 font-mono">
          <span className="text-git-added">+{status.totals.additions}</span>
          <span className="text-git-deleted">−{status.totals.deletions}</span>
          <span className="text-fg-muted">
            · {status.totals.files} file{status.totals.files === 1 ? '' : 's'}
          </span>
        </span>
      </div>
      <SplitBar added={status.totals.additions} deleted={status.totals.deletions} />
    </div>
  );
}

function FileContextMenu({ project, node, children }: { project: Project; node: FileNode; children: React.ReactNode }) {
  const deleted = node.file.status === 'deleted';
  const reveal = currentPlatform() === 'darwin' ? 'Reveal in Finder' : 'Reveal in Explorer';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* RowView does not forward props/ref: the trigger needs a DOM element. */}
        <div>{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-testid="changes-context-menu"
          className="z-50 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg"
        >
          <ContextMenu.Item className={menuItem} onSelect={() => openDiff(project.id, node.file, { pinned: true })}>
            Open diff
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => openDiffInNewGroup(project.id, node.file)}>
            Open diff in new group
          </ContextMenu.Item>
          {!deleted &&
            fileOpenersFor(node.path).map((opener) => (
              <ContextMenu.Item
                key={`${opener.pluginId}:${opener.id}`}
                className={menuItem}
                onSelect={() => void openWithOpener(opener, project.id, absolutePath(project, node.path))}
              >
                {opener.title}
              </ContextMenu.Item>
            ))}
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item
            className={menuItem}
            disabled={deleted}
            onSelect={() => void openInEditor(project, node.path)}
          >
            Open in editor
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} disabled={deleted} onSelect={() => revealInFolder(project, node.path)}>
            {reveal}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item className={menuItem} onSelect={() => void copyText(absolutePath(project, node.path))}>
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => void copyText(node.path)}>
            Copy relative path
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RowView({
  row,
  mode,
  selected,
  expanded,
  now,
  liveTouches,
  onClick,
  onDoubleClick,
}: {
  row: Row;
  mode: 'tree' | 'list';
  selected: boolean;
  expanded: boolean;
  now: number;
  liveTouches: Record<string, number>;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const node = row.node;
  const indent = { paddingLeft: mode === 'tree' ? 4 + row.depth * 12 : 6 };
  if (node.kind === 'dir') {
    const live = node.touchedAt !== undefined && now - node.touchedAt < LIVE_MS;
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={expanded}
        aria-selected={selected}
        data-testid="changes-row"
        data-path={node.path}
        data-kind="dir"
        onClick={onClick}
        style={indent}
        className={cn(
          'flex h-6 cursor-default items-center gap-1 rounded-badge pr-1.5 text-ui text-fg-secondary select-none hover:bg-card-hover',
          selected && 'bg-accent-muted text-fg',
        )}
      >
        {expanded ? (
          <ChevronDown size={13} className="flex-none text-fg-muted" />
        ) : (
          <ChevronRight size={13} className="flex-none text-fg-muted" />
        )}
        <Folder size={13} className="flex-none text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {live && <span data-testid="changes-live" className="size-1.5 flex-none rounded-full bg-accent" />}
        <span className="flex-none font-mono text-small text-fg-muted">{node.fileCount}</span>
        <span
          aria-label={STATUS_LABELS[node.status]}
          className={cn('size-1.5 flex-none rounded-full', STATUS_BG[node.status])}
        />
      </div>
    );
  }
  const f = node.file;
  const touchedAt = Math.max(f.touchedAt ?? 0, liveTouches[f.path] ?? 0);
  const live = touchedAt > 0 && now - touchedAt < LIVE_MS;
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      data-testid="changes-row"
      data-path={f.path}
      data-kind="file"
      data-status={f.status}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={indent}
      title={f.oldPath ? `${f.path}\nfrom: ${f.oldPath}` : f.path}
      className={cn(
        'flex h-6 cursor-default items-center gap-1.5 rounded-badge pr-1.5 text-ui select-none hover:bg-card-hover',
        selected && 'bg-accent-muted',
        live && 'animate-[oxy-row-pulse_1.5s_ease-out_1]',
      )}
    >
      {mode === 'tree' && <span className="w-[13px] flex-none" />}
      <File size={13} className="flex-none text-fg-muted" />
      <span className={cn('min-w-0 truncate text-fg', f.status === 'deleted' && 'text-fg-muted line-through')}>
        {node.name}
      </span>
      {mode === 'list' && node.dir && (
        <span className="min-w-0 flex-1 truncate text-small text-fg-muted">{node.dir}</span>
      )}
      <span className="flex-1" />
      {live && <span data-testid="changes-live" className="oxy-dot size-1.5 flex-none rounded-full bg-accent" />}
      {f.binary ? (
        <span className="flex-none font-mono text-small text-fg-muted">bin</span>
      ) : (
        (f.additions !== undefined || f.deletions !== undefined) && (
          <span className="flex-none font-mono text-small">
            {!!f.additions && <span className="text-git-added">+{f.additions}</span>}
            {!!f.deletions && <span className="ml-1 text-git-deleted">−{f.deletions}</span>}
          </span>
        )
      )}
      <span
        aria-label={STATUS_LABELS[f.status]}
        data-testid="changes-status-letter"
        className={cn('w-3 flex-none text-center font-mono text-small font-semibold', STATUS_TEXT_CLASS[f.status])}
      >
        {STATUS_LETTERS[f.status]}
      </span>
    </div>
  );
}

function ChangesTree({ project, status }: { project: Project; status: RepoStatus }) {
  const projectId = project.id;
  const ui = useChangesStore((s) => s.ui[projectId]) ?? changesUi(projectId);
  const liveTouches = useChangesStore((s) => s.touched[projectId]) ?? {};
  const setUi = useChangesStore((s) => s.setUi);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const showFilter = ui.filterOpen || ui.filter !== '';

  const tree = useMemo(() => buildTree(status.files), [status.files]);
  const expandedSet = useMemo(() => {
    if (ui.expanded) return new Set(ui.expanded);
    return status.files.length <= DEFAULT_EXPAND_LIMIT ? null : new Set<string>();
  }, [ui.expanded, status.files.length]);
  const rows = useMemo(
    () => (ui.mode === 'list' ? flattenList(status.files, ui.filter) : flattenTree(tree, expandedSet, ui.filter)),
    [ui.mode, ui.filter, status.files, tree, expandedSet],
  );
  const latestTouch = Math.max(0, ...status.files.map((f) => f.touchedAt ?? 0), ...Object.values(liveTouches));
  const now = useLiveNow(latestTouch);

  // The app does not use the React Compiler; the virtualizer's unstable callbacks are fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 300, height: 600 },
  });

  const selectedIndex = rows.findIndex((r) => r.node.path === ui.selected);
  const isExpanded = (path: string) => expandedSet === null || expandedSet.has(path);
  const setExpanded = (path: string, open: boolean) => {
    const current = expandedSet === null ? new Set(allDirPaths(tree)) : new Set(expandedSet);
    if (open) current.add(path);
    else current.delete(path);
    setUi(projectId, { expanded: [...current] });
  };
  const select = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setUi(projectId, { selected: row.node.path });
    virtualizer.scrollToIndex(index);
  };

  useEffect(() => {
    if (ui.filterOpen) filterRef.current?.focus();
  }, [ui.filterOpen]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    switch (e.key) {
      case 'ArrowDown':
        select(Math.min(rows.length - 1, selectedIndex + 1));
        break;
      case 'ArrowUp':
        select(Math.max(0, selectedIndex - 1));
        break;
      case 'ArrowRight':
        if (row?.node.kind === 'dir') {
          if (!isExpanded(row.node.path)) setExpanded(row.node.path, true);
          else select(selectedIndex + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.node.kind === 'dir' && isExpanded(row.node.path) && ui.mode === 'tree')
          setExpanded(row.node.path, false);
        else select(parentRowIndex(rows, selectedIndex));
        break;
      case 'Enter':
        if (row?.node.kind === 'dir') setExpanded(row.node.path, !isExpanded(row.node.path));
        else if (row && (e.ctrlKey || e.metaKey)) {
          if (row.node.file.status !== 'deleted') void openInEditor(project, row.node.path);
        } else if (row) openDiff(projectId, row.node.file);
        break;
      case ' ':
        // Preview without moving the focus out of the tree.
        if (row?.node.kind === 'file') {
          openDiff(projectId, row.node.file);
          requestAnimationFrame(() => scrollRef.current?.focus());
        }
        break;
      case '/':
        setUi(projectId, { filterOpen: true });
        filterRef.current?.focus();
        break;
      case 'Home':
        select(0);
        break;
      case 'End':
        select(rows.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFilter && (
        <div className="mb-1 flex h-7 flex-none items-center gap-1 rounded-control border border-line bg-input px-1.5">
          <Search size={12} className="flex-none text-fg-muted" />
          <input
            ref={filterRef}
            data-testid="changes-filter"
            aria-label="Filter changes"
            placeholder="Filter changes"
            value={ui.filter}
            onChange={(e) => setUi(projectId, { filter: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setUi(projectId, { filter: '', filterOpen: false });
                scrollRef.current?.focus();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                scrollRef.current?.focus();
                select(0);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-muted"
          />
          <button
            type="button"
            aria-label="Clear filter"
            className="text-fg-muted hover:text-fg"
            onClick={() => setUi(projectId, { filter: '', filterOpen: false })}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {status.truncated && (
        <div
          data-testid="changes-truncated"
          className="mb-1 rounded-control bg-warning/10 px-2 py-1 text-small text-warning"
        >
          Showing {status.truncated.shown.toLocaleString('en-US')} of {status.truncated.total.toLocaleString('en-US')}{' '}
          changes — consider updating .gitignore
        </div>
      )}
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Changes"
        tabIndex={0}
        data-testid="changes-tree"
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (selectedIndex < 0 && rows.length > 0) setUi(projectId, { selected: rows[0]!.node.path });
        }}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-line-focus"
      >
        {rows.length === 0 ? (
          <EmptyState title="No matching changes" className="py-3" />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const view = (
                <RowView
                  row={row}
                  mode={ui.mode}
                  selected={item.index === selectedIndex}
                  expanded={row.node.kind === 'dir' && isExpanded(row.node.path)}
                  now={now}
                  liveTouches={liveTouches}
                  onClick={() => {
                    setUi(projectId, { selected: row.node.path });
                    if (row.node.kind === 'dir') setExpanded(row.node.path, !isExpanded(row.node.path));
                    else openDiff(projectId, row.node.file);
                  }}
                  onDoubleClick={() => {
                    if (row.node.kind === 'file') openDiff(projectId, row.node.file, { pinned: true });
                  }}
                />
              );
              return (
                <div
                  key={`${row.node.kind}:${row.node.path}`}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                >
                  {row.node.kind === 'file' ? (
                    <FileContextMenu project={project} node={row.node}>
                      {view}
                    </FileContextMenu>
                  ) : (
                    view
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** CHANGES sidebar section (docs/plan/06-git-changes.md §6). */
export function ChangesSection() {
  const project = useProjectsStore(activeProject);
  const status = useChangesStore((s) => (project ? s.status[project.id] : undefined));

  useEffect(() => {
    if (project && !useChangesStore.getState().status[project.id]) void useChangesStore.getState().load(project.id);
  }, [project]);

  let body;
  if (!project) body = <EmptyState title="No project selected" className="py-4" />;
  else if (!status) body = <EmptyState title="Reading changes…" className="py-4" />;
  else if (status.state === 'not-a-repo') body = <EmptyState title="Not a git repository" className="py-4" />;
  else if (status.state === 'git-missing')
    body = (
      <EmptyState
        title="Git not found"
        description="Install Git or set git.path in the settings to see changes."
        className="py-4"
      />
    );
  else if (status.state === 'error')
    body = <EmptyState title="Could not read changes" description={status.error} className="py-4" />;
  else {
    body = (
      <>
        <BranchSummary status={status} />
        {!status.hasHead && status.files.length > 0 && (
          <div className="mb-1 text-small text-fg-muted">No commits yet — all files are new</div>
        )}
        {status.files.length === 0 ? (
          <EmptyState
            title={status.hasHead ? 'No changes since HEAD ✓' : 'No commits yet'}
            {...(status.headCommit
              ? {
                  description: (
                    <>
                      Last commit <RelativeAge at={status.headCommit.date} />: {status.headCommit.subject}
                    </>
                  ),
                }
              : {})}
            className="py-3"
          />
        ) : (
          <ChangesTree project={project} status={status} />
        )}
      </>
    );
  }
  return (
    <SectionBody className="flex flex-col">
      <div data-testid="changes-section" className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>
    </SectionBody>
  );
}
