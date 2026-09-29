import { create } from 'zustand';
import type { UpdateState } from '@shared/domain/updates';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { notify } from '../../ui/Toast';
import { manualCheckMessage } from './update-model';

export const useUpdateStore = create<{ state: UpdateState | null; panelOpen: boolean }>(() => ({
  state: null,
  panelOpen: false,
}));

/** The status bar popover with the download progress and the install choices. */
export function setUpdatePanelOpen(open: boolean): void {
  useUpdateStore.setState({ panelOpen: open });
}

let announced: string | undefined;

function apply(state: UpdateState): void {
  useUpdateStore.setState({ state });
  // One toast per downloaded version (unless the popover already shows it); the status bar keeps offering the
  // restart afterwards.
  if (state.status === 'ready' && state.version && announced !== state.version) {
    announced = state.version;
    if (useUpdateStore.getState().panelOpen) return;
    notify('info', `Oxytocin ${state.version} is ready to install`, {
      id: 'update-ready',
      description: 'Install it now, or it installs the next time you quit Oxytocin.',
      duration: 15_000,
      action: { label: 'Install now', onClick: () => void restartToUpdate() },
      cancel: { label: 'On restart', onClick: () => {} },
    });
  }
}

let subscribed = false;
/** Auto-update state from main (M9-T2). */
export function subscribeUpdates(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('updates:state', apply);
  void ipc.invoke('updates:getState').then(apply);
}

/** "Check for Updates": runs a check now and reports the result; a download shows its progress in the popover. */
export async function checkForUpdates(): Promise<void> {
  try {
    const state = await ipc.invoke('updates:check');
    if (state.status === 'downloading' && !state.disabledReason) {
      setUpdatePanelOpen(true);
      return;
    }
    const message = manualCheckMessage(state);
    if (message) notify(message.kind, message.message, message.description ? { description: message.description } : {});
  } catch (e) {
    notify('error', 'Could not check for updates', { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Retries a failed check or download from the popover, which then shows the new state. */
export async function retryUpdate(): Promise<void> {
  try {
    await ipc.invoke('updates:check');
  } catch (e) {
    notify('error', 'Could not check for updates', { description: e instanceof Error ? e.message : String(e) });
  }
}

/** Quits through the running-process confirmation and starts the new version. */
export async function restartToUpdate(): Promise<void> {
  await ipc.invoke('updates:restart');
}

export function registerUpdateCommands(): void {
  registerCommand({ id: 'workbench.checkForUpdates', title: 'Help: Check for Updates', run: () => checkForUpdates() });
  registerCommand({
    id: 'workbench.restartToUpdate',
    title: 'Help: Restart to Update',
    run: () => restartToUpdate(),
    when: () => useUpdateStore.getState().state?.status === 'ready',
  });
}
