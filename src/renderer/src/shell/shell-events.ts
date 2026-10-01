import { MENU_COMMANDS } from '@shared/domain/app-menu';
import { dismissNotification, showNotification } from '../features/attention/attention';
import { revealTerminal } from '../features/attention/reveal';
import { openEditorInTerminal } from '../features/layout/editor-terminal';
import { closePluginTerminalPanel, openPluginTerminal, runCoreCommand } from '../features/layout/core-commands';
import { executeCommand } from '../lib/commands';
import { ipc } from '../lib/ipc-client';
import { notify } from '../ui/Toast';

const menuCommands = new Set<string>(MENU_COMMANDS);

/**
 * Wires main's push events that drive the shell (toasts, reveals, plugin terminals, core and menu commands).
 * Returns the unsubscribe: the shell mounts twice under StrictMode in development, which would otherwise deliver
 * every event twice (two terminals for one "new terminal").
 */
export function subscribeShellEvents(): () => void {
  const listeners = [
    ipc.on('notifications:show', showNotification),
    ipc.on('notifications:dismiss', ({ requestId }) => dismissNotification(requestId)),
    ipc.on('terminals:reveal', ({ projectId, terminalId }) => void revealTerminal(projectId, terminalId)),
    ipc.on('editor:openInTerminal', (req) => void openEditorInTerminal(req)),
    ipc.on('terminals:openPanel', (req) => void openPluginTerminal(req)),
    ipc.on('terminals:closePanel', (req) => closePluginTerminalPanel(req)),
    ipc.on('commands:run', ({ id, args }) => runCoreCommand(id, args)),
    ipc.on('app:menuCommand', ({ command }) => {
      if (!menuCommands.has(command)) return;
      void executeCommand(command).catch((e: unknown) =>
        notify('error', 'The menu command failed', { description: e instanceof Error ? e.message : String(e) }),
      );
    }),
  ];
  return () => {
    for (const dispose of listeners.splice(0)) dispose();
  };
}
