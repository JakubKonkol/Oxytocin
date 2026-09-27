import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ITerminalOptions, Terminal } from '@xterm/xterm';
import type { Settings } from '@shared/domain/settings';
import { buildXtermTheme } from '../../lib/theme';
import { ipc } from '../../lib/ipc-client';

export interface XtermBundle {
  term: Terminal;
  fit: FitAddon;
  /** Loads the WebGL renderer after `open()` when enabled in settings (falls back to DOM on context loss). */
  enableWebgl: () => void;
  disposeWebgl: () => void;
  /** Live switch of `terminal.renderer` (settings UI). */
  setRenderer: (renderer: Settings['terminal.renderer']) => void;
}

/** Options that follow the settings live in open terminals (09 §3.3). */
export function liveTerminalOptions(settings: Settings): Partial<ITerminalOptions> {
  return {
    fontFamily: settings['terminal.fontFamily'],
    fontSize: settings['terminal.fontSize'],
    lineHeight: settings['terminal.lineHeight'],
    cursorStyle: settings['terminal.cursorStyle'],
    cursorBlink: settings['terminal.cursorBlink'],
    scrollback: settings['terminal.scrollback'],
    macOptionIsMeta: settings['terminal.macOptionIsMeta'],
    screenReaderMode: settings['terminal.screenReaderMode'],
  };
}

/** Options whose change alters the cell size (the terminal is refitted). */
export const LAYOUT_OPTIONS: ReadonlySet<string> = new Set(['fontFamily', 'fontSize', 'lineHeight']);

const MAX_WEBGL_CONTEXTS = 8;
let activeWebglContexts = 0;

export function createXterm(settings: Settings, env: { platform: string; osBuild: number }): XtermBundle {
  const term = new Terminal({
    ...liveTerminalOptions(settings),
    letterSpacing: 0,
    allowProposedApi: true,
    allowTransparency: false,
    rightClickSelectsWord: env.platform === 'darwin',
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    theme: buildXtermTheme(),
    ...(env.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: env.osBuild } } : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) void ipc.invoke('shell:openExternal', { url: uri });
    }),
  );

  let renderer = settings['terminal.renderer'];
  let webgl: WebglAddon | null = null;
  const disposeWebgl = () => {
    if (!webgl) return;
    webgl.dispose();
    webgl = null;
    activeWebglContexts--;
  };
  const enableWebgl = () => {
    if (webgl || renderer !== 'webgl' || activeWebglContexts >= MAX_WEBGL_CONTEXTS) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => disposeWebgl());
      term.loadAddon(addon);
      webgl = addon;
      activeWebglContexts++;
    } catch {
      webgl = null; // WebGL unavailable → DOM renderer
    }
  };
  const setRenderer = (next: Settings['terminal.renderer']) => {
    if (next === renderer) return;
    renderer = next;
    if (next === 'webgl') enableWebgl();
    else disposeWebgl();
  };
  return { term, fit, enableWebgl, disposeWebgl, setRenderer };
}
