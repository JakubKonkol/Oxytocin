import type { TerminalInfo } from '@shared/domain/terminal';
import type { NotificationPayload } from '@shared/ipc/events';
import { registerCommand } from '../../lib/commands';
import { useTerminalsStore } from '../../stores/terminals-store';
import { ipc } from '../../lib/ipc-client';
import { dismissToast, notify, notifyWithActions } from '../../ui/Toast';
import { isTerminalVisible, revealTerminal } from './reveal';
import { firstEnsembleNeed } from '../ensemble/EnsembleStatusItem';
import { showEnsemble } from '../ensemble/ensemble-actions';

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
    const ensemble = firstEnsembleNeed();
    if (ensemble) return showEnsemble(ensemble.projectId, ensemble.taskId);
    notify('info', 'No agent is waiting for you');
    return;
  }
  const index = waiting.findIndex((t) => t.id === lastJumped);
  const next = waiting[(index + 1) % waiting.length]!;
  lastJumped = next.id;
  await revealTerminal(next.projectId, next.id);
}

const actionToastId = (requestId: string) => `request-${requestId}`;

/** Main withdrew a toast with buttons (answered elsewhere, no longer relevant or timed out). */
export function dismissNotification(requestId: string): void {
  dismissToast(actionToastId(requestId));
}

/** Toast requested by main; skipped when it is about a terminal already on screen. */
export function showNotification(n: NotificationPayload): void {
  if (n.actions?.length && n.requestId) {
    notifyWithActions(n.kind, n.message, {
      ...(n.description ? { description: n.description } : {}),
      id: actionToastId(n.requestId),
      actions: n.actions,
      onDone: (actionId) => void ipc.invoke('notifications:action', { requestId: n.requestId!, actionId }),
    });
    return;
  }
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
