import { create } from 'zustand';

/** Most recently used first. The active project is always mounted. */
export function touchLru(mounted: readonly string[], id: string, limit: number): string[] {
  const next = [id, ...mounted.filter((m) => m !== id)];
  return next.slice(0, Math.max(1, limit));
}

interface WorkspacesStore {
  /** Mounted workspaces (MRU order), capped by `workspace.keepAliveProjects`. */
  mounted: string[];
  activate: (id: string, limit: number) => void;
  unmount: (id: string) => void;
  retain: (ids: ReadonlySet<string>) => void;
}

export const useWorkspacesStore = create<WorkspacesStore>((set, get) => ({
  mounted: [],
  activate(id, limit) {
    const next = touchLru(get().mounted, id, limit);
    if (next.join() !== get().mounted.join()) set({ mounted: next });
  },
  unmount(id) {
    set({ mounted: get().mounted.filter((m) => m !== id) });
  },
  retain(ids) {
    const next = get().mounted.filter((m) => ids.has(m));
    if (next.length !== get().mounted.length) set({ mounted: next });
  },
}));
