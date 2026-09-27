import { app, BrowserWindow, nativeTheme } from 'electron';
import { APP_HOST, APP_ORIGIN, APP_SCHEME } from './protocols';
import { appPaths } from './paths';
import { hardenWebContents, secureWebPreferences } from './security';

/** Native window chrome per theme (mirrors --bg-app / --text-secondary in tokens.css; main cannot read CSS). */
const CHROME = {
  dark: { background: '#0b0d10', symbols: '#a8b0bb' },
  light: { background: '#e9ecf0', symbols: '#4b5563' },
} as const;
const chrome = () => CHROME[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

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

const TITLE_BAR_HEIGHT = 36;

/** Title bar overlay colors for the current theme (Windows/Linux). */
export function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  const c = chrome();
  return { color: c.background, symbolColor: c.symbols, height: TITLE_BAR_HEIGHT };
}

/**
 * `appearance.theme` drives `nativeTheme.themeSource`, so the renderer's `prefers-color-scheme` follows the
 * setting ("system" follows the OS). Native chrome (window background, title bar overlay) is updated here.
 */
export function applyNativeTheme(theme: 'dark' | 'light' | 'system'): void {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
}

export function trackNativeTheme(win: BrowserWindow): void {
  const update = () => {
    if (win.isDestroyed()) return;
    // Only the overlay: the page paints its own background, and changing the native background color of a
    // shown window left a stale blank frame on Linux (the creation color already follows the theme).
    if (process.platform !== 'darwin') win.setTitleBarOverlay(titleBarOverlay());
  };
  nativeTheme.on('updated', update);
  win.on('closed', () => nativeTheme.off('updated', update));
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...opts.bounds,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Oxytocin',
    // Avoids a flash of the wrong color before the renderer paints.
    backgroundColor: chrome().background,
    ...(isMac ? {} : { icon: appPaths.windowIcon() }),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: titleBarOverlay() }),
    webPreferences: secureWebPreferences(appPaths.preload),
  });
  hardenWebContents(win.webContents, isTrustedShellUrl);
  trackNativeTheme(win);
  win.once('ready-to-show', () => {
    if (opts.maximized) win.maximize();
    win.show();
  });
  const dev = devRendererUrl();
  void win.loadURL(dev ?? `${APP_ORIGIN}/index.html`);
  return win;
}
