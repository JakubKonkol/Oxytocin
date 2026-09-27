import type { AgentInfo } from '@shared/domain/agent';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { StatusDotState } from '../../ui/StatusDot';

function agentDotState(agent: AgentInfo): StatusDotState {
  switch (agent.state) {
    case 'waiting':
      return 'attention';
    case 'working':
    case 'starting':
      return 'agent-working';
    case 'idle':
      return 'idle';
    default:
      return 'running';
  }
}

/** Status dot for a single terminal. */
export function terminalDotState(info: TerminalInfo): StatusDotState {
  if (info.state === 'failed') return 'error';
  if (info.state === 'exited') return (info.exitCode ?? 0) === 0 ? 'idle' : 'error';
  if (info.kind === 'agent') return info.agent ? agentDotState(info.agent) : 'agent-working';
  if (info.kind === 'process') return 'running';
  return 'idle';
}

function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "Claude Code is waiting for tool permission · 2 min" */
export function agentStateLabel(agent: AgentInfo, now = Date.now()): string {
  const since = formatDuration(now - agent.since);
  switch (agent.state) {
    case 'waiting': {
      const what = agent.waitingFor
        ? ` for ${agent.waitingFor === 'permission' ? 'tool permission' : agent.waitingFor}`
        : ' for you';
      return `${agent.displayName} is waiting${what} · ${since}`;
    }
    case 'working':
      return `${agent.displayName} is working · ${since}`;
    case 'idle':
      return `${agent.displayName} is idle · ${since}`;
    case 'starting':
      return `${agent.displayName} is starting`;
    default:
      return `${agent.displayName} is running`;
  }
}

export function terminalDotLabel(info: TerminalInfo): string {
  if (info.state === 'failed') return info.error ?? 'Disconnected';
  if (info.state === 'exited') return `Process exited with code ${info.exitCode ?? 0}`;
  if (info.kind === 'agent') return info.agent ? agentStateLabel(info.agent) : 'Agent working';
  if (info.kind === 'process') return info.foreground ? `${info.foreground.name} is running` : 'Process running';
  return 'Idle';
}
