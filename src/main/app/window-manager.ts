import { app, BrowserWindow } from 'electron';
import { APP_HOST, APP_ORIGIN, APP_SCHEME } from './protocols';
import { appPaths } from './paths';
import { hardenWebContents, secureWebPreferences } from './security';

const WINDOW_BACKGROUND = '#0b0d10'; // --bg-app; avoids a white flash before the renderer paints.

export function devRendererUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL'];
  return !app.isPackaged && url ? url : null;
}

export function isTrustedShellUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Node's URL gives custom schemes an opaque ("null") origin, so compare protocol and host.
    if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true;
    const dev = devRendererUrl();
    return dev !== null && parsed.origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

export interface MainWindowOptions {
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
}

/** Title bar overlay colors (tokens --bg-app / --text-secondary); updated with the theme in M7. */
export const TITLE_BAR_OVERLAY = { color: WINDOW_BACKGROUND, symbolColor: '#a8b0bb', height: 36 };

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...opts.bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Oxytocin',
    backgroundColor: WINDOW_BACKGROUND,
    ...(isMac ? {} : { icon: appPaths.windowIcon() }),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: TITLE_BAR_OVERLAY }),
    webPreferences: secureWebPreferences(appPaths.preload),
  });
  hardenWebContents(win.webContents, isTrustedShellUrl);
  win.once('ready-to-show', () => {
    if (opts.maximized) win.maximize();
    win.show();
  });
  const dev = devRendererUrl();
  void win.loadURL(dev ?? `${APP_ORIGIN}/index.html`);
  return win;
}
