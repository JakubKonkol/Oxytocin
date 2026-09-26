import { getActiveWorkspace } from '../features/layout/workspace-registry';
import { getLastProjectSwitchMs } from './perf';
import { getActiveTerminalId } from '../features/terminals/terminal-actions';
import { terminalRegistry, terminalText } from '../features/terminals/terminal-registry';

/** E2E-only hooks (installed only when OXYTOCIN_E2E=1) — read terminal buffers without scraping the DOM. */
export function installTestHooks(): void {
  (window as unknown as Record<string, unknown>)['__oxyTest'] = {
    terminalIds: () => [...terminalRegistry.keys()],
    lastSwitchMs: () => getLastProjectSwitchMs(),
    activeTerminalId: () => getActiveTerminalId(),
    /** Moves a panel into another group (the operation a tab drop performs). */
    movePanel: (panelId: string, targetPanelId: string) => {
      const api = getActiveWorkspace()?.api;
      const panel = api?.getPanel(panelId);
      const target = api?.getPanel(targetPanelId);
      if (!panel || !target) return false;
      panel.api.moveTo({ group: target.group, position: 'center' });
      return true;
    },
    /** Snapshot of the active dockview workspace. */
    workspace: () => {
      const ws = getActiveWorkspace();
      if (!ws) return null;
      const api = ws.api;
      return {
        groups: api.groups.length,
        maximized: api.hasMaximizedGroup(),
        activeGroup: api.activeGroup
          ? { id: api.activeGroup.id, width: api.activeGroup.width, height: api.activeGroup.height }
          : null,
        activePanelId: api.activePanel?.id ?? null,
        panels: api.panels.map((p) => ({
          id: p.id,
          group: p.group.id,
          terminalId: (p.params as { terminalId?: string } | undefined)?.terminalId ?? null,
        })),
      };
    },
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
