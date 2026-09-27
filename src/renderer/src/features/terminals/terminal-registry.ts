import type { Terminal } from '@xterm/xterm';

export interface RegisteredTerminal {
  term: Terminal;
  focus: () => void;
  /** Sends raw input to the PTY (bypassing xterm's paste handling). */
  sendRaw: (data: string) => void;
  openFind?: () => void;
}

/** terminalId → live xterm instance (used by commands, keybindings and E2E hooks). */
export const terminalRegistry = new Map<string, RegisteredTerminal>();

/** The buffer as text, one line per logical line: rows soft-wrapped at the terminal width are joined. */
export function terminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    // A row that continues on the next one fills the full width: keep its trailing spaces.
    const text = line?.translateToString(!buffer.getLine(i + 1)?.isWrapped) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').replace(/\s+$/, '');
}
