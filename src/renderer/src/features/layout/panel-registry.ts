/** Center-area panel kinds. Params hold identifiers only. */
export type PanelKind =
  | 'terminal'
  | 'diff'
  | 'plugin'
  | 'scratchpad'
  | 'ensemble'
  | 'plugins'
  | 'keybindings'
  | 'settings'
  | 'welcome'
  | 'missing';

export interface TerminalPanelParams {
  terminalId: string;
  /** Agent session that ran here before the restart: offered by the "Resume session" bar (M7-T6). */
  resume?: { agentId: string; sessionId: string };
}

export interface MissingPanelParams {
  reason: string;
}

let counter = 0;
/** Short random panel ids: term-xxxxxxxx. */
export function newPanelId(kind: 'term' | 'diff' | 'plg' | 'tool'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36);
  return `${kind}-${rand}${counter.toString(36)}`;
}
