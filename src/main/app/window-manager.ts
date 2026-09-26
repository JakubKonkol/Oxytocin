import { app, BrowserWindow } from 'electron';
import { APP_ORIGIN } from './protocols';
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
    if (parsed.origin === APP_ORIGIN) return true;
    const dev = devRendererUrl();
    return dev !== null && parsed.origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Oxytocin',
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: secureWebPreferences(appPaths.preload),
  });
  hardenWebContents(win.webContents, isTrustedShellUrl);
  win.once('ready-to-show', () => win.show());
  const dev = devRendererUrl();
  void win.loadURL(dev ?? `${APP_ORIGIN}/index.html`);
  return win;
}
