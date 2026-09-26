import type { Terminal } from '@xterm/xterm';

export interface RegisteredTerminal {
  term: Terminal;
  focus: () => void;
  /** Sends raw input to the PTY (bypassing xterm's paste handling). */
  sendRaw: (data: string) => void;
}

/** terminalId → live xterm instance (used by commands, keybindings and E2E hooks). */
export const terminalRegistry = new Map<string, RegisteredTerminal>();

export function terminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n').replace(/\s+$/, '');
}
