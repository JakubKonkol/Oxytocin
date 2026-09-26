import { create } from 'zustand';

export interface ViewMeta {
  title?: string;
  badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | null;
}

interface ViewMetaStore {
  meta: Record<string, ViewMeta>;
  set: (instanceId: string, patch: ViewMeta) => void;
}

/** Title/badge set by sidebar views (shown in their pane headers). */
export const usePluginViewMeta = create<ViewMetaStore>((set) => ({
  meta: {},
  set: (instanceId, patch) => set((s) => ({ meta: { ...s.meta, [instanceId]: { ...s.meta[instanceId], ...patch } } })),
}));
