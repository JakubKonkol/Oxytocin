import type { TerminalInfo } from '@shared/domain/terminal';
import type { StatusDotState } from '../../ui/StatusDot';

/** Client-side project activity until the main-side aggregation (M3-T5). */
export function projectDotState(terminals: readonly TerminalInfo[]): StatusDotState {
  if (terminals.length === 0) return 'none';
  if (terminals.some((t) => t.state === 'failed' || (t.state === 'exited' && (t.exitCode ?? 0) !== 0))) return 'error';
  if (terminals.some((t) => t.state === 'running' && t.kind === 'agent')) return 'agent-working';
  if (terminals.some((t) => t.state === 'running' && t.kind === 'process')) return 'running';
  return 'idle';
}
