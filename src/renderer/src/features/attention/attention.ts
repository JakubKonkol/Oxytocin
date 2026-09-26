import type { TerminalInfo } from '@shared/domain/terminal';
import type { NotificationPayload } from '@shared/ipc/events';
import { registerCommand } from '../../lib/commands';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import { isTerminalVisible, revealTerminal } from './reveal';

/** Running terminals whose agent waits for the user, longest waiting first. */
export function waitingTerminals(terminals: Record<string, TerminalInfo>): TerminalInfo[] {
  return Object.values(terminals)
    .filter((t) => t.state === 'running' && t.agent?.state === 'waiting')
    .sort((a, b) => (a.agent?.since ?? 0) - (b.agent?.since ?? 0));
}

let lastJumped: string | null = null;

/** Ctrl+Shift+J: cycles through waiting agents. */
export async function jumpToWaitingAgent(): Promise<void> {
  const waiting = waitingTerminals(useTerminalsStore.getState().terminals);
  if (waiting.length === 0) {
    notify('info', 'No agent is waiting for you');
    return;
  }
  const index = waiting.findIndex((t) => t.id === lastJumped);
  const next = waiting[(index + 1) % waiting.length]!;
  lastJumped = next.id;
  await revealTerminal(next.projectId, next.id);
}

/** Toast requested by main; skipped when it is about a terminal already on screen. */
export function showNotification(n: NotificationPayload): void {
  const target = n.target;
  if (target && n.onlyIfHidden && isTerminalVisible(target.projectId, target.terminalId)) return;
  notify(n.kind, n.message, {
    ...(n.description ? { description: n.description } : {}),
    ...(target
      ? {
          id: `terminal-${target.terminalId}`,
          action: { label: 'Show', onClick: () => void revealTerminal(target.projectId, target.terminalId) },
        }
      : {}),
  });
}

export function registerAttentionCommands(): void {
  registerCommand({
    id: 'agents.jumpToWaiting',
    title: 'Agents: Jump to Waiting Agent',
    run: () => jumpToWaitingAgent(),
  });
}
