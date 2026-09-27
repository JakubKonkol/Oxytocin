import { create } from 'zustand';
import type { QuickPickRequest } from '@shared/domain/quick-pick';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';

interface PaletteStore {
  isOpen: boolean;
  /** Initial input (a mode prefix such as ">"). Changes re-seed the input of an open palette. */
  initial: string;
  /** Bumped on every open so an already open palette re-seeds its input. */
  openCount: number;
  /** A plugin's pick shown instead of Quick Open. */
  pick: QuickPickRequest | null;
  open: (initial?: string) => void;
  close: () => void;
}

export const usePaletteStore = create<PaletteStore>((set, get) => ({
  isOpen: false,
  initial: '',
  openCount: 0,
  pick: null,
  open(initial = '') {
    dismissPick();
    set({ isOpen: true, initial, openCount: get().openCount + 1, pick: null });
  },
  close() {
    dismissPick();
    set({ isOpen: false, pick: null });
  },
}));

function dismissPick(): void {
  const pick = usePaletteStore.getState().pick;
  if (pick) void ipc.invoke('ui:quickPickResult', { requestId: pick.requestId, index: null });
}

/** Answers the current plugin pick and closes the palette. */
export function resolvePick(index: number): void {
  const pick = usePaletteStore.getState().pick;
  if (!pick) return;
  usePaletteStore.setState({ isOpen: false, pick: null });
  void ipc.invoke('ui:quickPickResult', { requestId: pick.requestId, index });
}

export function registerPaletteCommands(): void {
  registerCommand({
    id: 'workbench.commandPalette',
    title: 'View: Show All Commands',
    run: () => usePaletteStore.getState().open('>'),
  });
  registerCommand({
    id: 'workbench.quickOpen',
    title: 'View: Quick Open',
    run: () => usePaletteStore.getState().open(''),
  });
  registerCommand({
    id: 'workbench.showTerminals',
    title: 'Terminal: Go to Terminal…',
    run: () => usePaletteStore.getState().open('@'),
  });
  registerCommand({
    id: 'workbench.showChangedFiles',
    title: 'Changes: Go to Changed File…',
    run: () => usePaletteStore.getState().open('#'),
  });
  ipc.on('ui:quickPick', (request) => {
    dismissPick();
    usePaletteStore.setState((s) => ({ isOpen: true, initial: '', openCount: s.openCount + 1, pick: request }));
  });
}
