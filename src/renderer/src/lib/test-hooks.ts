import { terminalRegistry, terminalText } from '../features/terminals/terminal-registry';

/** E2E-only hooks (installed only when OXYTOCIN_E2E=1) — read terminal buffers without scraping the DOM. */
export function installTestHooks(): void {
  (window as unknown as Record<string, unknown>)['__oxyTest'] = {
    terminalIds: () => [...terminalRegistry.keys()],
    getTerminalText: (id: string) => {
      const entry = terminalRegistry.get(id);
      return entry ? terminalText(entry.term) : null;
    },
    getTerminalSize: (id: string) => {
      const term = terminalRegistry.get(id)?.term;
      return term ? { cols: term.cols, rows: term.rows } : null;
    },
    /** Client coordinates of the centre of the first cell of `text` (for mouse interactions). */
    textPosition: (id: string, text: string) => {
      const term = terminalRegistry.get(id)?.term;
      const screen = term?.element?.querySelector('.xterm-screen');
      if (!term || !screen) return null;
      const rect = screen.getBoundingClientRect();
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const x = buffer.getLine(y)?.translateToString(true).indexOf(text) ?? -1;
        if (x >= 0) {
          const cw = rect.width / term.cols;
          const ch = rect.height / term.rows;
          return { x: rect.left + (x + 0.5) * cw, y: rect.top + (y - buffer.viewportY + 0.5) * ch };
        }
      }
      return null;
    },
    /** Selects the first occurrence of `text` in the buffer. */
    selectText: (id: string, text: string) => {
      const term = terminalRegistry.get(id)?.term;
      if (!term) return false;
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const x = buffer.getLine(y)?.translateToString(true).indexOf(text) ?? -1;
        if (x >= 0) {
          term.select(x, y, text.length);
          return true;
        }
      }
      return false;
    },
    /** Finds `text` in the buffer and returns the foreground color of its first cell. */
    getTextColor: (id: string, text: string) => {
      const term = terminalRegistry.get(id)?.term;
      if (!term) return null;
      const buffer = term.buffer.active;
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        const x = line?.translateToString(true).indexOf(text) ?? -1;
        if (line && x >= 0) {
          const cell = line.getCell(x);
          if (!cell) return null;
          return {
            fg: cell.getFgColor(),
            palette: cell.isFgPalette(),
            rgb: cell.isFgRGB(),
            default: cell.isFgDefault(),
          };
        }
      }
      return null;
    },
  };
}
