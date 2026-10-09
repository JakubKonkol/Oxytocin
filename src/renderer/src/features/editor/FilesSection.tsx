import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  RotateCw,
  Search,
} from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import type { Project } from '@shared/domain/project';
import { cn } from '../../lib/cn';
import { currentPlatform } from '../../lib/platform';
import { useChangesStore } from '../../stores/changes-store';
import { activeProject, useProjectsStore } from '../../stores/projects-store';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { SectionBody } from '../../ui/Section';
import { askAgent } from '../ask-agent/ask-agent-store';
import { absolutePath, copyText, openInEditor, revealInFolder } from '../changes/change-actions';
import { STATUS_BG, STATUS_LABELS, STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { openDiff } from '../diff/diff-actions';
import { usePaletteStore } from '../palette/palette-store';
import { openFile } from './editor-actions';
import { deleteEntry, newEntry, renameEntry } from './file-ops';
import { type FileRow, flattenFiles, statusIndex } from './files-model';
import { useFilesStore } from './files-store';

const ROW_HEIGHT = 22;
const EMPTY: string[] = [];

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';
const separator = 'my-1 h-px bg-line-subtle';

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function FilesHeaderActions() {
  const id = useProjectsStore((s) => s.activeId);
  if (!id) return null;
  return (
    <>
      <IconButton
        data-testid="files-quick-open"
        label="Go to file"
        icon={<Search size={13} />}
        onClick={() => usePaletteStore.getState().open('%')}
      />
      <IconButton
        data-testid="files-new-file"
        label="New file"
        icon={<FilePlus size={13} />}
        onClick={() => void newEntry(id, '', 'file')}
      />
      <IconButton label="New folder" icon={<FolderPlus size={13} />} onClick={() => void newEntry(id, '', 'dir')} />
      <IconButton
        label="Refresh"
        icon={<RotateCw size={13} />}
        onClick={() => void useFilesStore.getState().refresh(id)}
      />
      <IconButton
        label="Collapse all"
        icon={<ChevronsDownUp size={13} />}
        onClick={() => useFilesStore.getState().collapseAll(id)}
      />
    </>
  );
}

function RowMenu({ project, row, children }: { project: Project; row: FileRow; children: React.ReactNode }) {
  const change = useChangesStore((s) => s.status[project.id]?.files.find((f) => f.path === row.path));
  const reveal = currentPlatform() === 'darwin' ? 'Reveal in Finder' : 'Reveal in Explorer';
  const dir = row.kind === 'dir' ? row.path : parentOf(row.path);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div>{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-testid="files-context-menu"
          className="z-50 min-w-52 rounded-control border border-line bg-elevated p-1 shadow-lg"
        >
          {row.kind === 'file' && (
            <>
              <ContextMenu.Item className={menuItem} onSelect={() => openFile(project.id, row.path, { pinned: true })}>
                Open
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={() => openFile(project.id, row.path, { side: true })}>
                Open to the Side
              </ContextMenu.Item>
              {change && (
                <ContextMenu.Item className={menuItem} onSelect={() => openDiff(project.id, change, { pinned: true })}>
                  Open Diff
                </ContextMenu.Item>
              )}
              <ContextMenu.Item
                className={menuItem}
                onSelect={() => askAgent({ projectId: project.id, contexts: [{ kind: 'file', path: row.path }] })}
              >
                Ask Agent About File…
              </ContextMenu.Item>
              <ContextMenu.Separator className={separator} />
            </>
          )}
          <ContextMenu.Item className={menuItem} onSelect={() => void newEntry(project.id, dir, 'file')}>
            New File…
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => void newEntry(project.id, dir, 'dir')}>
            New Folder…
          </ContextMenu.Item>
          <ContextMenu.Separator className={separator} />
          <ContextMenu.Item className={menuItem} onSelect={() => void renameEntry(project.id, row.path)}>
            Rename…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cn(menuItem, 'text-danger')}
            onSelect={() => void deleteEntry(project.id, row.path, row.kind)}
          >
            Delete
          </ContextMenu.Item>
          <ContextMenu.Separator className={separator} />
          <ContextMenu.Item className={menuItem} onSelect={() => void copyText(absolutePath(project, row.path))}>
            Copy Path
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => void copyText(row.path)}>
            Copy Relative Path
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => revealInFolder(project, row.path)}>
            {reveal}
          </ContextMenu.Item>
          {row.kind === 'file' && (
            <ContextMenu.Item className={menuItem} onSelect={() => void openInEditor(project, row.path)}>
              Open in External Editor
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function FilesTree({ project }: { project: Project }) {
  const projectId = project.id;
  const dirs = useFilesStore((s) => s.dirs[projectId]);
  const expandedList = useFilesStore((s) => s.expanded[projectId] ?? EMPTY);
  const selected = useFilesStore((s) => s.selected[projectId] ?? null);
  const revealNonce = useFilesStore((s) => s.revealNonce);
  const changes = useChangesStore((s) => s.status[projectId]?.files);
  const scrollRef = useRef<HTMLDivElement>(null);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const rows = useMemo(() => (dirs ? flattenFiles(dirs, expanded) : []), [dirs, expanded]);
  const statuses = useMemo(() => statusIndex(changes ?? []), [changes]);
  const store = useFilesStore.getState();

  useEffect(() => {
    if (!useFilesStore.getState().dirs[projectId]?.['']) void useFilesStore.getState().load(projectId, '');
  }, [projectId]);

  // The app does not use the React Compiler; the virtualizer's unstable callbacks are fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 300, height: 600 },
  });

  const selectedIndex = rows.findIndex((r) => r.path === selected);
  useEffect(() => {
    if (revealNonce && selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'center' });
    // Only when a reveal was asked for (not on every selection change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, selectedIndex >= 0]);

  const activate = (row: FileRow, pinned: boolean) => {
    if (row.note) return;
    store.select(projectId, row.path);
    if (row.kind === 'dir') store.setExpanded(projectId, row.path, !expanded.has(row.path));
    else openFile(projectId, row.path, { pinned });
  };
  const selectIndex = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!row) return;
    store.select(projectId, row.path);
    virtualizer.scrollToIndex(rows.indexOf(row));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    switch (e.key) {
      case 'ArrowDown':
        selectIndex(selectedIndex + 1);
        break;
      case 'ArrowUp':
        selectIndex(selectedIndex - 1);
        break;
      case 'ArrowRight':
        if (row?.kind === 'dir' && !expanded.has(row.path)) store.setExpanded(projectId, row.path, true);
        else selectIndex(selectedIndex + 1);
        break;
      case 'ArrowLeft':
        if (row?.kind === 'dir' && expanded.has(row.path)) store.setExpanded(projectId, row.path, false);
        else if (row) {
          const parent = parentOf(row.path);
          const index = rows.findIndex((r) => r.path === parent);
          if (index >= 0) selectIndex(index);
        }
        break;
      case 'Enter':
        if (row) activate(row, true);
        break;
      case ' ':
        if (row?.kind === 'file') {
          openFile(projectId, row.path);
          requestAnimationFrame(() => scrollRef.current?.focus());
        } else if (row) activate(row, false);
        break;
      case 'F2':
        if (row && !row.note) void renameEntry(projectId, row.path);
        break;
      case 'Delete':
        if (row && !row.note) void deleteEntry(projectId, row.path, row.kind);
        break;
      case 'Home':
        selectIndex(0);
        break;
      case 'End':
        selectIndex(rows.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const root = dirs?.[''];
  if (!root) return <EmptyState title="Reading files…" className="py-3" />;
  if ('error' in root)
    return <EmptyState title="Could not read the folder" description={root.error} className="py-3" />;
  if (rows.length === 0) return <EmptyState title="The project folder is empty" className="py-3" />;

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Files"
      tabIndex={0}
      data-testid="files-tree"
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (selectedIndex < 0 && rows.length > 0) store.select(projectId, rows[0]!.path);
      }}
      className="min-h-0 flex-1 overflow-auto pt-1 outline-none focus-visible:ring-1 focus-visible:ring-line-focus"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const status = statuses.get(row.path);
          const isOpen = row.kind === 'dir' && expanded.has(row.path);
          const view = (
            <div
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={item.index === selectedIndex}
              {...(row.kind === 'dir' ? { 'aria-expanded': isOpen } : {})}
              data-testid="files-row"
              data-path={row.path}
              data-kind={row.kind}
              title={row.path}
              onClick={() => activate(row, false)}
              onDoubleClick={() => row.kind === 'file' && activate(row, true)}
              style={{ paddingLeft: 4 + row.depth * 12 }}
              className={cn(
                'flex h-[22px] cursor-default items-center gap-1 rounded-badge pr-1.5 text-ui select-none hover:bg-card-hover',
                item.index === selectedIndex && 'bg-accent-muted',
                row.note && 'text-small text-fg-muted italic',
                row.note === 'error' && 'text-danger',
              )}
            >
              {row.kind === 'dir' ? (
                isOpen ? (
                  <ChevronDown size={13} className="flex-none text-fg-muted" />
                ) : (
                  <ChevronRight size={13} className="flex-none text-fg-muted" />
                )
              ) : (
                <span className="w-[13px] flex-none" />
              )}
              {row.kind === 'dir' ? (
                isOpen ? (
                  <FolderOpen size={13} className="flex-none text-fg-muted" />
                ) : (
                  <Folder size={13} className="flex-none text-fg-muted" />
                )
              ) : (
                !row.note && <File size={13} className="flex-none text-fg-muted" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  row.ignored ? 'text-fg-muted' : 'text-fg',
                  status && STATUS_TEXT_CLASS[status],
                  status === 'deleted' && 'line-through',
                )}
              >
                {row.name}
                {row.symlink && <span className="ml-1 text-small text-fg-muted">↗</span>}
              </span>
              {status &&
                (row.kind === 'dir' ? (
                  <span
                    aria-label={STATUS_LABELS[status]}
                    className={cn('size-1.5 flex-none rounded-full', STATUS_BG[status])}
                  />
                ) : (
                  <span
                    aria-label={STATUS_LABELS[status]}
                    className={cn(
                      'w-3 flex-none text-center font-mono text-small font-semibold',
                      STATUS_TEXT_CLASS[status],
                    )}
                  >
                    {STATUS_LETTERS[status]}
                  </span>
                ))}
            </div>
          );
          return (
            <div
              key={row.path}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
            >
              {row.note ? (
                view
              ) : (
                <RowMenu project={project} row={row}>
                  {view}
                </RowMenu>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** FILES sidebar section: the project's folders and files; files open in the built-in code editor. */
export function FilesSection() {
  const project = useProjectsStore(activeProject);
  return (
    <SectionBody className="flex flex-col">
      <div data-testid="files-section" className="flex min-h-0 flex-1 flex-col">
        {project ? (
          project.missing ? (
            <EmptyState title="The project folder is missing" className="py-4" />
          ) : (
            <FilesTree key={project.id} project={project} />
          )
        ) : (
          <EmptyState title="No project selected" className="py-4" />
        )}
      </div>
    </SectionBody>
  );
}
