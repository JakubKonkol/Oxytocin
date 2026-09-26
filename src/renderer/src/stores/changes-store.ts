import { create } from 'zustand';
import type { RepoStatus } from '@shared/domain/git';
import { ipc } from '../lib/ipc-client';

export interface ChangesUi {
  /** Expanded folder keys; null = default (everything expanded when ≤ 50 files, else collapsed). */
  expanded: string[] | null;
  mode: 'tree' | 'list';
  filter: string;
  selected: string | null;
  /** Filter field shown (not persisted). */
  filterOpen: boolean;
}

export const DEFAULT_CHANGES_UI: ChangesUi = {
  expanded: null,
  mode: 'tree',
  filter: '',
  selected: null,
  filterOpen: false,
};

/** "Live" highlight window after a file-system event. */
export const LIVE_MS = 5000;

interface ChangesStore {
  status: Record<string, RepoStatus>;
  /** projectId → path → last touch (from `git:fileTouched`, before the status catches up). */
  touched: Record<string, Record<string, number>>;
  ui: Record<string, ChangesUi>;
  load: (projectId: string) => Promise<void>;
  setUi: (projectId: string, patch: Partial<ChangesUi>) => void;
}

export const useChangesStore = create<ChangesStore>((set) => ({
  status: {},
  touched: {},
  ui: {},
  async load(projectId) {
    const status = await ipc.invoke('git:getStatus', { projectId });
    if (status) set((s) => ({ status: { ...s.status, [projectId]: status } }));
  },
  setUi(projectId, patch) {
    set((s) => ({ ui: { ...s.ui, [projectId]: { ...(s.ui[projectId] ?? DEFAULT_CHANGES_UI), ...patch } } }));
  },
}));

export const changesUi = (projectId: string) => useChangesStore.getState().ui[projectId] ?? DEFAULT_CHANGES_UI;

let subscribed = false;
export function subscribeChanges(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('git:status', (status) =>
    useChangesStore.setState((s) => ({ status: { ...s.status, [status.projectId]: status } })),
  );
  ipc.on('git:fileTouched', ({ projectId, paths, at }) =>
    useChangesStore.setState((s) => {
      const cutoff = at - LIVE_MS;
      const current = Object.fromEntries(Object.entries(s.touched[projectId] ?? {}).filter(([, t]) => t >= cutoff));
      for (const p of paths) current[p] = at;
      return { touched: { ...s.touched, [projectId]: current } };
    }),
  );
}
