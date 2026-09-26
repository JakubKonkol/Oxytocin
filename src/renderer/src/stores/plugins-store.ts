import { create } from 'zustand';
import type { Contributions, PluginDescriptor } from '@shared/domain/plugin';
import { ipc } from '../lib/ipc-client';

const EMPTY: Contributions = {
  views: [],
  panels: [],
  statusBarItems: [],
  commands: [],
  configuration: [],
  fileOpeners: [],
  terminalProfiles: [],
  agents: [],
};

interface PluginsStore {
  plugins: PluginDescriptor[];
  contributions: Contributions;
  load: () => Promise<void>;
}

export const usePluginsStore = create<PluginsStore>((set) => ({
  plugins: [],
  contributions: EMPTY,
  async load() {
    const [plugins, contributions] = await Promise.all([
      ipc.invoke('plugins:list'),
      ipc.invoke('plugins:contributions'),
    ]);
    set({ plugins, contributions });
  },
}));

let subscribed = false;
export function subscribePlugins(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('plugins:changed', (plugins) => usePluginsStore.setState({ plugins }));
  ipc.on('plugins:contributionsChanged', (contributions) => usePluginsStore.setState({ contributions }));
}
