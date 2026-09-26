import type { Terminal } from '@xterm/xterm';
import type { Settings } from '@shared/domain/settings';
import { dispatchKeybinding } from '../../lib/keyboard';
import type { UiPlatform } from '../../lib/platform';
import { copySelection, pasteClipboard } from './terminal-actions';

export interface TerminalKeyHandlerDeps {
  term: Terminal;
  platform: UiPlatform;
  settings: () => Settings;
  sendRaw: (data: string) => void;
}

/**
 * xterm's custom key handler: returns false for keys the app handles (xterm then ignores them).
 * Order: Shift+Enter mapping → Windows-Terminal-style Ctrl+C / Ctrl+V → app keybindings (terminal-safe chords only).
 */
export function createTerminalKeyHandler(deps: TerminalKeyHandlerDeps): (e: KeyboardEvent) => boolean {
  const { term, platform, sendRaw } = deps;
  const isMac = platform === 'darwin';
  return (e) => {
    if (e.type !== 'keydown') return true;
    if (e.isComposing) return true;
    const settings = deps.settings();
    const onlyShift = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    const onlyCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;

    if (e.code === 'Enter' && onlyShift) {
      const seq = settings['terminal.shiftEnterSequence'];
      if (!seq) return true;
      e.preventDefault();
      sendRaw(seq);
      return false;
    }

    if (!isMac && onlyCtrl && e.code === 'KeyC') {
      if (settings['terminal.ctrlCBehavior'] === 'copyIfSelection' && term.hasSelection()) {
        e.preventDefault();
        void copySelection(term);
        return false;
      }
      return true; // → \x03 (SIGINT)
    }

    if (!isMac && onlyCtrl && e.code === 'KeyV') {
      if (settings['terminal.ctrlVBehavior'] === 'passthrough') return true;
      e.preventDefault();
      void pasteClipboard(term, sendRaw);
      return false;
    }

    if (dispatchKeybinding(e, 'terminalFocus')) {
      e.preventDefault();
      return false;
    }
    return true;
  };
}
