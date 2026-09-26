import type { Terminal } from '@xterm/xterm';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { getSettings } from '../../stores/settings-store';
import { terminalRegistry } from './terminal-registry';

let activeTerminalId: string | null = null;

export function setActiveTerminal(id: string): void {
  activeTerminalId = id;
}

export function getActiveTerminalId(): string | null {
  return activeTerminalId && terminalRegistry.has(activeTerminalId) ? activeTerminalId : null;
}

export async function copySelection(term: Terminal): Promise<boolean> {
  if (!term.hasSelection()) return false;
  await ipc.invoke('clipboard:writeText', { text: term.getSelection() });
  term.clearSelection();
  return true;
}

/**
 * Pastes clipboard text. An image-only clipboard sends a raw Ctrl+V (\x16) so agents such as Claude Code
 * read the image themselves. Multi-line pastes without bracketed paste mode ask for confirmation.
 */
export async function pasteClipboard(term: Terminal, sendRaw: (data: string) => void): Promise<void> {
  const { text, hasImage } = await ipc.invoke('clipboard:read');
  if (!text) {
    if (hasImage) sendRaw('\x16');
    return;
  }
  await pasteText(term, text);
}

export async function pasteText(term: Terminal, text: string): Promise<void> {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  if (lines > 1 && !term.modes.bracketedPasteMode && getSettings()['terminal.confirmMultilinePaste']) {
    const ok = await confirmDialog({
      title: `Paste ${lines} lines?`,
      description: 'Each line may be executed by the shell.',
      confirmLabel: 'Paste',
    });
    if (!ok) return;
  }
  term.paste(text);
}

/** Terminal commands that act on the last focused terminal. */
export function registerTerminalCommands(): void {
  const active = () => {
    const id = getActiveTerminalId();
    return id ? { id, entry: terminalRegistry.get(id)! } : null;
  };
  registerCommand({
    id: 'terminal.copy',
    title: 'Terminal: Copy Selection',
    run: async () => {
      const a = active();
      if (a) await copySelection(a.entry.term);
    },
  });
  registerCommand({
    id: 'terminal.paste',
    title: 'Terminal: Paste',
    run: async () => {
      const a = active();
      if (a) await pasteClipboard(a.entry.term, a.entry.sendRaw);
    },
  });
  registerCommand({
    id: 'terminal.clear',
    title: 'Terminal: Clear',
    run: () => active()?.entry.term.clear(),
  });
  registerCommand({
    id: 'terminal.find',
    title: 'Terminal: Find',
    run: () => active()?.entry.openFind?.(),
  });
  registerCommand({
    id: 'terminal.selectAll',
    title: 'Terminal: Select All',
    run: () => active()?.entry.term.selectAll(),
  });
}
