import type { TerminalInfo } from '@shared/domain/terminal';
import type { StatusDotState } from '../../ui/StatusDot';

/** Status dot for a single terminal (docs/plan/02-ui-ux.md §6); agent states arrive with M3-T4. */
export function terminalDotState(info: TerminalInfo): StatusDotState {
  if (info.state === 'failed') return 'error';
  if (info.state === 'exited') return (info.exitCode ?? 0) === 0 ? 'idle' : 'error';
  if (info.kind === 'agent') return 'agent-working';
  if (info.kind === 'process') return 'running';
  return 'idle';
}

export function terminalDotLabel(info: TerminalInfo): string {
  if (info.state === 'failed') return info.error ?? 'Disconnected';
  if (info.state === 'exited') return `Process exited with code ${info.exitCode ?? 0}`;
  if (info.kind === 'agent') return 'Agent working';
  if (info.kind === 'process') return 'Process running';
  return 'Idle';
}
