import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('oxy', { platform: process.platform });
