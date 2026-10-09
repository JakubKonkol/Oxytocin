import { create } from 'zustand';
import type { FileEntry } from '@shared/domain/files';
import { ipc } from '../../lib/ipc-client';
import { useUiStore } from '../../stores/ui-store';
import { activateProject } from '../projects/project-actions';
import { getSidebarPaneviewApi } from '../tools/tools';

/** A loaded folder: its entries, or why it could not be read. */
export type DirState = { entries: FileEntry[] } | { error: string };

interface FilesStore {
  /** projectId → folder path ('' = project folder) → entries. */
  dirs: Record<string, Record<string, DirState>>;
  expanded: Record<string, string[]>;
  selected: Record<string, string | null>;
  /** Bumped by `revealInFiles` so the section scrolls to the selection. */
  revealNonce: number;
  load: (projectId: string, dir: string) => Promise<void>;
  setExpanded: (projectId: string, dir: string, open: boolean) => void;
  collapseAll: (projectId: string) => void;
  select: (projectId: string, path: string | null) => void;
  /** Reloads every loaded folder of a project. */
  refresh: (projectId: string) => Promise<void>;
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export const useFilesStore = create<FilesStore>((set, get) => ({
  dirs: {},
  expanded: {},
  selected: {},
  revealNonce: 0,
  async load(projectId, dir) {
    let state: DirState;
    try {
      state = { entries: await ipc.invoke('files:list', { projectId, path: dir }) };
    } catch (e) {
      state = { error: e instanceof Error ? e.message : String(e) };
    }
    set((s) => ({ dirs: { ...s.dirs, [projectId]: { ...s.dirs[projectId], [dir]: state } } }));
  },
  setExpanded(projectId, dir, open) {
    const current = new Set(get().expanded[projectId] ?? []);
    if (open) current.add(dir);
    else current.delete(dir);
    set((s) => ({ expanded: { ...s.expanded, [projectId]: [...current] } }));
    if (open && !get().dirs[projectId]?.[dir]) void get().load(projectId, dir);
  },
  collapseAll(projectId) {
    set((s) => ({ expanded: { ...s.expanded, [projectId]: [] } }));
  },
  select(projectId, path) {
    set((s) => ({ selected: { ...s.selected, [projectId]: path } }));
  },
  async refresh(projectId) {
    const loaded = Object.keys(get().dirs[projectId] ?? {});
    await Promise.all(loaded.map((dir) => get().load(projectId, dir)));
  },
}));

/** Folders whose listing may have changed after writes to `paths` (their parents, when loaded). */
export function dirsToReload(loaded: readonly string[], paths: readonly string[]): string[] {
  const have = new Set(loaded);
  const out = new Set<string>();
  for (const p of paths) {
    const parent = parentOf(p);
    if (have.has(parent)) out.add(parent);
  }
  return [...out];
}

let subscribed = false;
const pending = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** Keeps loaded folders in sync with the file system (the Workspace Host's watcher). */
export function subscribeFiles(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('git:fileTouched', ({ projectId, paths }) => {
    if (!useFilesStore.getState().dirs[projectId]) return;
    const set = pending.get(projectId) ?? new Set<string>();
    for (const p of paths) set.add(p);
    pending.set(projectId, set);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const store = useFilesStore.getState();
      for (const [id, touched] of pending) {
        for (const dir of dirsToReload(Object.keys(store.dirs[id] ?? {}), [...touched])) void store.load(id, dir);
      }
      pending.clear();
    }, 400);
  });
}

/** Ancestor folders of a path, outermost first ('a/b/c.ts' → ['a', 'a/b']). */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Shows a file in the FILES section: its folders expanded, the file selected and scrolled to. */
export function revealInFiles(projectId: string, path: string): void {
  activateProject(projectId);
  const store = useFilesStore.getState();
  for (const dir of ancestors(path)) store.setExpanded(projectId, dir, true);
  store.select(projectId, path);
  useFilesStore.setState((s) => ({ revealNonce: s.revealNonce + 1 }));
  const ui = useUiStore.getState();
  if (ui.state.sidebar.collapsed) ui.toggleSidebar();
  const pane = getSidebarPaneviewApi('left')?.getPanel('files');
  if (pane && !pane.api.isExpanded) pane.api.setExpanded(true);
}
