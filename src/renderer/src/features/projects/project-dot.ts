import type { TerminalInfo } from '@shared/domain/terminal';
import type { StatusDotState } from '../../ui/StatusDot';
import { terminalDotState } from '../terminals/terminal-status';

const PRIORITY: StatusDotState[] = ['attention', 'error', 'agent-working', 'running', 'idle'];

/** Client-side project activity until the main-side aggregation (M3-T5): the most urgent terminal state wins. */
export function projectDotState(terminals: readonly TerminalInfo[]): StatusDotState {
  if (terminals.length === 0) return 'none';
  const states = new Set(terminals.map(terminalDotState));
  return PRIORITY.find((s) => states.has(s)) ?? 'idle';
}
