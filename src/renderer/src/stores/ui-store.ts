import { create } from 'zustand';
import {
  defaultUiState,
  type PaneviewState,
  SCRATCHPAD_MAX_LENGTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type UiState,
  type UiStatePatch,
} from '@shared/domain/ui-state';
import { ipc } from '../lib/ipc-client';

interface UiStore {
  loaded: boolean;
  state: UiState;
  load: () => Promise<void>;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  setPaneview: (paneview: PaneviewState) => void;
  setSecondarySidebarWidth: (width: number) => void;
  toggleSecondarySidebar: (open?: boolean) => void;
  setSecondaryPaneview: (paneview: PaneviewState) => void;
  setScratchpadText: (text: string) => void;
  /** Moves a command to the top of the palette's "recently used" list. */
  recordCommand: (id: string) => void;
}

const RECENT_COMMANDS_MAX = 20;

let pending: UiStatePatch = {};
let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced persistence of renderer-owned UI state to ui-state.json (main). */
function persist(patch: UiStatePatch): void {
  pending = {
    ...pending,
    ...patch,
    ...(patch.sidebar || pending.sidebar ? { sidebar: { ...pending.sidebar, ...patch.sidebar } } : {}),
    ...(patch.secondarySidebar || pending.secondarySidebar
      ? { secondarySidebar: { ...pending.secondarySidebar, ...patch.secondarySidebar } }
      : {}),
  };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const toSend = pending;
    pending = {};
    timer = undefined;
    void ipc.invoke('ui:patchState', toSend);
  }, 300);
}

export const clampSidebarWidth = (w: number) => Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w)));

export const useUiStore = create<UiStore>((set, get) => ({
  loaded: false,
  state: defaultUiState(),
  async load() {
    const state = await ipc.invoke('ui:getState');
    set({ state, loaded: true });
  },
  setSidebarWidth(width) {
    const sidebar = { ...get().state.sidebar, width: clampSidebarWidth(width) };
    set({ state: { ...get().state, sidebar } });
    persist({ sidebar: { width: sidebar.width } });
  },
  toggleSidebar() {
    const sidebar = { ...get().state.sidebar, collapsed: !get().state.sidebar.collapsed };
    set({ state: { ...get().state, sidebar } });
    persist({ sidebar: { collapsed: sidebar.collapsed } });
  },
  setPaneview(paneview) {
    set({ state: { ...get().state, paneview } });
    persist({ paneview });
  },
  setSecondarySidebarWidth(width) {
    const secondarySidebar = { ...get().state.secondarySidebar, width: clampSidebarWidth(width) };
    set({ state: { ...get().state, secondarySidebar } });
    persist({ secondarySidebar: { width: secondarySidebar.width } });
  },
  toggleSecondarySidebar(open) {
    const collapsed = open === undefined ? !get().state.secondarySidebar.collapsed : !open;
    if (collapsed === get().state.secondarySidebar.collapsed) return;
    const secondarySidebar = { ...get().state.secondarySidebar, collapsed };
    set({ state: { ...get().state, secondarySidebar } });
    persist({ secondarySidebar: { collapsed } });
  },
  setSecondaryPaneview(secondaryPaneview) {
    set({ state: { ...get().state, secondaryPaneview } });
    persist({ secondaryPaneview });
  },
  setScratchpadText(text) {
    const scratchpad = { text: text.slice(0, SCRATCHPAD_MAX_LENGTH) };
    set({ state: { ...get().state, scratchpad } });
    persist({ scratchpad });
  },
  recordCommand(id) {
    const recentCommands = [id, ...get().state.recentCommands.filter((c) => c !== id)].slice(0, RECENT_COMMANDS_MAX);
    set({ state: { ...get().state, recentCommands } });
    persist({ recentCommands });
  },
}));
