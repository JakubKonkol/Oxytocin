import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { Settings } from '@shared/domain/settings';
import { buildXtermTheme } from '../../lib/theme';
import { ipc } from '../../lib/ipc-client';

export interface XtermBundle {
  term: Terminal;
  fit: FitAddon;
  /** Loads the WebGL renderer after `open()` when enabled in settings (falls back to DOM on context loss). */
  enableWebgl: () => void;
  disposeWebgl: () => void;
}

const MAX_WEBGL_CONTEXTS = 8;
let activeWebglContexts = 0;

export function createXterm(settings: Settings, env: { platform: string; osBuild: number }): XtermBundle {
  const term = new Terminal({
    fontFamily: settings['terminal.fontFamily'],
    fontSize: settings['terminal.fontSize'],
    lineHeight: settings['terminal.lineHeight'],
    letterSpacing: 0,
    cursorStyle: settings['terminal.cursorStyle'],
    cursorBlink: settings['terminal.cursorBlink'],
    scrollback: settings['terminal.scrollback'],
    allowProposedApi: true,
    allowTransparency: false,
    macOptionIsMeta: settings['terminal.macOptionIsMeta'],
    rightClickSelectsWord: env.platform === 'darwin',
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    screenReaderMode: settings['terminal.screenReaderMode'],
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

  let webgl: WebglAddon | null = null;
  const disposeWebgl = () => {
    if (!webgl) return;
    webgl.dispose();
    webgl = null;
    activeWebglContexts--;
  };
  const enableWebgl = () => {
    if (webgl || settings['terminal.renderer'] !== 'webgl' || activeWebglContexts >= MAX_WEBGL_CONTEXTS) return;
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
  return { term, fit, enableWebgl, disposeWebgl };
}
