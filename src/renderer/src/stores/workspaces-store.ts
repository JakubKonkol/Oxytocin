import { create } from 'zustand';

/**
 * Most recently used first. The active project is always mounted; so are workspaces that `keep` (unsaved edits in
 * an editor would be lost by unmounting), even beyond the limit.
 */
export function touchLru(
  mounted: readonly string[],
  id: string,
  limit: number,
  keep: (id: string) => boolean = () => false,
): string[] {
  const next = [id, ...mounted.filter((m) => m !== id)];
  const cap = Math.max(1, limit);
  return next.filter((m, i) => i < cap || keep(m));
}

interface WorkspacesStore {
  /** Mounted workspaces (MRU order), capped by `workspace.keepAliveProjects`. */
  mounted: string[];
  activate: (id: string, limit: number, keep?: (id: string) => boolean) => void;
  unmount: (id: string) => void;
  retain: (ids: ReadonlySet<string>) => void;
}

export const useWorkspacesStore = create<WorkspacesStore>((set, get) => ({
  mounted: [],
  activate(id, limit, keep) {
    const next = touchLru(get().mounted, id, limit, keep);
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
