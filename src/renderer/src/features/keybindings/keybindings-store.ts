import { create } from 'zustand';
import type { KeybindingsState } from '@shared/domain/keybindings';
import { ipc } from '../../lib/ipc-client';
import { setUserKeybindings } from '../../lib/keyboard';

interface KeybindingsStore {
  state: KeybindingsState | null;
  load: () => Promise<void>;
}

function apply(state: KeybindingsState): void {
  setUserKeybindings(state.entries);
  useKeybindingsStore.setState({ state });
}

export const useKeybindingsStore = create<KeybindingsStore>(() => ({
  state: null,
  async load() {
    apply(await ipc.invoke('keybindings:get'));
  },
}));

let subscribed = false;
/** keybindings.json changes (shortcut editor or external edits) apply immediately. */
export function subscribeKeybindings(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('keybindings:changed', apply);
}

/** Writes the user entries of one command (empty = back to the defaults). */
export async function setCommandKeybindings(command: string, entries: KeybindingsState['entries']): Promise<void> {
  apply(await ipc.invoke('keybindings:setForCommand', { command, entries }));
}
