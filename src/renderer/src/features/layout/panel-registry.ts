/** Center-area panel kinds (docs/plan/05-layout-center.md §3). Params hold identifiers only. */
export type PanelKind = 'terminal' | 'diff' | 'plugin' | 'welcome' | 'missing';

export interface TerminalPanelParams {
  terminalId: string;
}

export interface MissingPanelParams {
  reason: string;
}

let counter = 0;
/** Short random panel ids: term-xxxxxxxx. */
export function newPanelId(kind: 'term' | 'diff' | 'plg'): string {
  counter = (counter + 1) % 1_000_000;
  const rand = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36);
  return `${kind}-${rand}${counter.toString(36)}`;
}
