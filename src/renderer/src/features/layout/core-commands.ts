import { executeCommand } from '../../lib/commands';
import { useTerminalsStore } from '../../stores/terminals-store';
import { revealTerminal, workspaceFor } from '../attention/reveal';
import { openDiff } from '../diff/diff-actions';
import { activateProject } from '../projects/project-actions';
import { addExistingTerminalPanel } from './workspace-actions';

/** A terminal created by a plugin (`oxy.terminals.create`): show it in its project's workspace. */
export async function openPluginTerminal(req: {
  terminalId: string;
  projectId: string;
  placement: 'active-group' | 'right' | 'below';
}): Promise<void> {
  const api = await workspaceFor(req.projectId);
  if (!api) return;
  const info = useTerminalsStore.getState().terminals[req.terminalId];
  const exists = api.panels.some(
    (p) => (p.params as { terminalId?: string } | undefined)?.terminalId === req.terminalId,
  );
  if (exists) return;
  const id = addExistingTerminalPanel(api, req.terminalId, info?.title ?? 'Terminal');
  if (req.placement !== 'active-group') {
    const panel = api.getPanel(id);
    const reference = api.activeGroup;
    if (panel && reference && reference !== panel.group)
      panel.api.moveTo({ group: reference, position: req.placement === 'right' ? 'right' : 'bottom' });
  }
}

/** Core commands plugins may run (`oxytocin.*`). */
export function runCoreCommand(id: string, args: unknown[]): void {
  switch (id) {
    case 'oxytocin.terminal.new':
      void executeCommand('terminal.new');
      break;
    case 'oxytocin.terminal.focus': {
      const t = useTerminalsStore.getState().terminals[String(args[0])];
      if (t) void revealTerminal(t.projectId, t.id);
      break;
    }
    case 'oxytocin.project.activate':
      if (typeof args[0] === 'string') activateProject(args[0]);
      break;
    case 'oxytocin.diff.open':
      if (typeof args[0] === 'string' && typeof args[1] === 'string') {
        const [projectId, path] = args as [string, string];
        void workspaceFor(projectId).then((api) => api && openDiff(projectId, { path }, { pinned: true, api }));
      }
      break;
    case 'oxytocin.panel.focus':
      void executeCommand('workbench.focusCenter');
      break;
    default:
      break;
  }
}
