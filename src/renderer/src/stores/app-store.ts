import { create } from 'zustand';
import type { AppInfo } from '@shared/domain/app-info';
import { ipc } from '../lib/ipc-client';

interface AppStore {
  info: AppInfo | null;
  load: () => Promise<void>;
}

export const useAppStore = create<AppStore>((set) => ({
  info: null,
  async load() {
    set({ info: await ipc.invoke('app:getInfo') });
  },
}));

export const useAppInfo = () => useAppStore((s) => s.info);
