import { create } from 'zustand';
import type { ConfirmTone } from '../ui/ConfirmDialog';
import { ipc } from '../lib/ipc-client';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Items the confirmation is about (e.g. running processes), shown as a list. */
  details?: readonly string[];
  /** Icon and colour (default: `danger` when destructive, else `info`). */
  tone?: ConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Optional checkbox shown in the dialog (e.g. "Also close its 2 terminals"). */
  checkbox?: { label: string; defaultChecked: boolean };
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (result: ConfirmResult) => void;
}

interface DialogStore {
  queue: PendingConfirm[];
  settle: (id: number, result: ConfirmResult) => void;
}

let nextId = 1;

export const useDialogStore = create<DialogStore>((set, get) => ({
  queue: [],
  settle(id, result) {
    const item = get().queue.find((q) => q.id === id);
    set({ queue: get().queue.filter((q) => q.id !== id) });
    item?.resolve(result);
  },
}));

/** Shows a confirmation dialog with an optional checkbox (rendered by DialogHost). */
export function confirmDialogEx(options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    useDialogStore.setState((s) => ({ queue: [...s.queue, { ...options, id: nextId++, resolve }] }));
  });
}

/** Shows a confirmation dialog; resolves true on confirm. */
export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return (await confirmDialogEx(options)).confirmed;
}

/** Confirmations the main process asks (`ui:confirm`, e.g. quitting with running processes) use the same dialog. */
export function registerMainConfirmRequests(): void {
  ipc.on('ui:confirm', ({ requestId, ...options }) => {
    void confirmDialogEx(options).then(({ confirmed, checked }) =>
      ipc.invoke('ui:confirmResult', { requestId, confirmed, checked }),
    );
  });
}
