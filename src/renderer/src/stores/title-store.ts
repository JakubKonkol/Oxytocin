import { create } from 'zustand';

export interface ActivePanelInfo {
  title: string;
  /** Terminal panels: the live title comes from TerminalInfo. */
  terminalId?: string;
}

/** Active panel of the visible workspace (window title / title bar). */
export const useTitleStore = create<{
  panel: ActivePanelInfo | null;
  setActivePanel: (p: ActivePanelInfo | null) => void;
}>((set) => ({
  panel: null,
  setActivePanel: (panel) => set({ panel }),
}));
