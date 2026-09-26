import type { AddPanelPositionOptions, DockviewApi } from 'dockview-react';
import type { CreateTerminalRequest } from '@shared/domain/terminal';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { getSettings } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import { newPanelId, type TerminalPanelParams } from './panel-registry';

export type PanelPosition = AddPanelPositionOptions;

/** Creates a terminal and opens it as a panel (default: in the active group). */
export async function addTerminalPanel(
  api: DockviewApi,
  req: CreateTerminalRequest,
  position?: PanelPosition,
): Promise<string | null> {
  let info;
  try {
    info = await ipc.invoke('terminals:create', req);
  } catch (e) {
    notify('error', 'Could not start the terminal', { description: e instanceof Error ? e.message : String(e) });
    return null;
  }
  useTerminalsStore.getState().upsert(info);
  const id = newPanelId('term');
  api.addPanel<TerminalPanelParams>({
    id,
    component: 'terminal',
    params: { terminalId: info.id },
    title: info.title,
    ...(position ? { position } : {}),
  });
  return id;
}

/** Adds panels for terminals that already exist in main (e.g. after a renderer reload). */
export function addExistingTerminalPanel(api: DockviewApi, terminalId: string, title: string): string {
  const id = newPanelId('term');
  api.addPanel<TerminalPanelParams>({ id, component: 'terminal', params: { terminalId }, title });
  return id;
}

function terminalIdOf(api: DockviewApi, panelId: string): string | undefined {
  const panel = api.getPanel(panelId);
  if (panel?.api.component !== 'terminal') return undefined;
  return (panel.params as TerminalPanelParams | undefined)?.terminalId;
}

/** Whether closing this terminal needs confirmation (`terminal.confirmOnKill`). */
export function needsKillConfirmation(terminalId: string): boolean {
  const info = useTerminalsStore.getState().terminals[terminalId];
  if (!info || info.state !== 'running') return false;
  const mode = getSettings()['terminal.confirmOnKill'];
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return info.kind !== 'shell';
}

/** Closes a panel; terminals are killed (after confirmation when a process is running). */
export async function requestClosePanel(
  api: DockviewApi,
  panelId: string,
  opts: { skipConfirm?: boolean } = {},
): Promise<boolean> {
  const panel = api.getPanel(panelId);
  if (!panel) return false;
  const terminalId = terminalIdOf(api, panelId);
  if (terminalId) {
    if (!opts.skipConfirm && needsKillConfirmation(terminalId)) {
      const info = useTerminalsStore.getState().terminals[terminalId]!;
      const what = info.kind === 'agent' ? info.profileName : 'A process';
      const ok = await confirmDialog({
        title: `${what} is running in this terminal. Terminate it?`,
        confirmLabel: 'Terminate',
        destructive: true,
      });
      if (!ok) return false;
    }
    panel.api.close();
    await ipc.invoke('terminals:dispose', { id: terminalId });
    return true;
  }
  panel.api.close();
  return true;
}

/** Restart = a new terminal in the same panel (the old buffer is kept above a separator in M2-T3). */
export async function restartTerminalPanel(api: DockviewApi, panelId: string): Promise<void> {
  const terminalId = terminalIdOf(api, panelId);
  if (!terminalId) return;
  const info = await ipc.invoke('terminals:restart', { id: terminalId });
  useTerminalsStore.getState().upsert(info);
  api.getPanel(panelId)?.api.updateParameters({ terminalId: info.id });
}
