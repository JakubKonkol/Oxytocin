import { join, resolve } from 'node:path';
import { app } from 'electron';

/** Runtime paths — always resolve them here. */
export const appPaths = {
  /** Directory of the built main bundle (out/main). Utility process entries live next to it. */
  mainDir: __dirname,
  rendererDir: join(__dirname, '../renderer'),
  preload: join(__dirname, '../preload/index.js'),
  hostEntry: (name: 'ptyHost' | 'workspaceHost' | 'pluginHost' | 'connectionsHost') => join(__dirname, `${name}.js`),
  builtinPluginsDir: () =>
    app.isPackaged ? join(process.resourcesPath, 'plugins') : resolve(__dirname, '../../plugins'),
  resourcesDir: () => (app.isPackaged ? process.resourcesPath : resolve(__dirname, '../../resources')),
  /** LICENSE / THIRD_PARTY_NOTICES.md: packaged into resources/, at the repository root in development. */
  legalFile: (name: 'LICENSE' | 'THIRD_PARTY_NOTICES.md') =>
    app.isPackaged ? join(process.resourcesPath, name) : resolve(__dirname, '../..', name),
  /** Window/taskbar icon (Windows: .ico, Linux: .png; macOS uses the bundle icon). */
  windowIcon: () => {
    const dir = join(app.isPackaged ? process.resourcesPath : resolve(__dirname, '../../resources'), 'icons');
    return process.platform === 'win32' ? join(dir, 'app-icon.ico') : join(dir, 'app-icon-512.png');
  },
};
