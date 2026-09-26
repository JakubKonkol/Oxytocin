import { create } from 'zustand';

/** Which panel's tab is being renamed inline. */
export const useRenameStore = create<{ panelId: string | null; start: (id: string) => void; stop: () => void }>(
  (set) => ({
    panelId: null,
    start: (panelId) => set({ panelId }),
    stop: () => set({ panelId: null }),
  }),
);
