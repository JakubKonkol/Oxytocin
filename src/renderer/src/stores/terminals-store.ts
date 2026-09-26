import { create } from 'zustand';
import type { TerminalInfo } from '@shared/domain/terminal';
import { ipc } from '../lib/ipc-client';

interface TerminalsStore {
  terminals: Record<string, TerminalInfo>;
  loaded: boolean;
  load: () => Promise<void>;
  upsert: (info: TerminalInfo) => void;
  remove: (id: string) => void;
}

export const useTerminalsStore = create<TerminalsStore>((set, get) => ({
  terminals: {},
  loaded: false,
  async load() {
    const list = await ipc.invoke('terminals:list', {});
    set({ terminals: Object.fromEntries(list.map((t) => [t.id, t])), loaded: true });
  },
  upsert(info) {
    set({ terminals: { ...get().terminals, [info.id]: info } });
  },
  remove(id) {
    const { [id]: _removed, ...rest } = get().terminals;
    set({ terminals: rest });
  },
}));

let subscribed = false;
export function subscribeTerminals(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('terminals:updated', (info) => useTerminalsStore.getState().upsert(info));
  ipc.on('terminals:removed', ({ id }) => useTerminalsStore.getState().remove(id));
}
