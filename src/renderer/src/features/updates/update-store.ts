import { create } from 'zustand';
import type { UpdateState } from '@shared/domain/updates';
import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { notify } from '../../ui/Toast';
import { manualCheckMessage } from './update-model';

export const useUpdateStore = create<{ state: UpdateState | null }>(() => ({ state: null }));

let announced: string | undefined;

function apply(state: UpdateState): void {
  useUpdateStore.setState({ state });
  // One toast per downloaded version; the status bar keeps offering the restart afterwards.
  if (state.status === 'ready' && state.version && announced !== state.version) {
    announced = state.version;
    notify('info', `Oxytocin ${state.version} is ready to install`, {
      id: 'update-ready',
      description: 'It installs when you quit Oxytocin, or restart now.',
      duration: 15_000,
      action: { label: 'Restart now', onClick: () => void restartToUpdate() },
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

/** "Check for Updates": runs a check now and reports the result. */
export async function checkForUpdates(): Promise<void> {
  try {
    const message = manualCheckMessage(await ipc.invoke('updates:check'));
    if (message) notify(message.kind, message.message, message.description ? { description: message.description } : {});
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
