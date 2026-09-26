import { create } from 'zustand';
import type { Settings } from '@shared/domain/settings';
import { ipc } from '../lib/ipc-client';

interface SettingsStore {
  settings: Settings | null;
  load: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: null,
  async load() {
    set({ settings: await ipc.invoke('settings:get') });
  },
}));

let subscribed = false;
/** Keeps the store in sync with settings.json edits (settings:changed). */
export function subscribeSettings(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('settings:changed', (settings) => useSettingsStore.setState({ settings }));
}

/** Current settings outside React (throws before load). */
export function getSettings(): Settings {
  const s = useSettingsStore.getState().settings;
  if (!s) throw new Error('Settings not loaded');
  return s;
}
