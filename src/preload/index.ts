import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@shared/ipc/channels';
import type { OxyPreloadApi } from '@shared/ipc/preload-api';

const invokeChannels = new Set<string>(INVOKE_CHANNELS);
const eventChannels = new Set<string>(EVENT_CHANNELS);

const api: OxyPreloadApi = {
  invoke(channel, payload) {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload) as Promise<unknown>;
  },
  on(event, listener) {
    if (!eventChannels.has(event)) throw new Error(`Blocked IPC event: ${event}`);
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.removeListener(event, wrapped);
    };
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform as OxyPreloadApi['platform'],
  e2e: process.env['OXYTOCIN_E2E'] === '1',
};

contextBridge.exposeInMainWorld('oxy', api);
