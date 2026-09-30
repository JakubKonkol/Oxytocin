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
  /** A third button (e.g. "Always allow"); a click confirms with `secondary: true`. */
  secondaryLabel?: string;
  /** Monospace text in a scrollable block (e.g. a tool's arguments). */
  code?: string;
  /** Asks for an answer: one of `options`, or free text (returned as `value`; confirming needs one). */
  input?: { kind: 'options'; options: string[] } | { kind: 'text'; placeholder?: string };
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
  secondary?: boolean;
  value?: string;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  /** Id of a request from main (it can withdraw it with `ui:confirmDismiss`). */
  requestId?: string;
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
export function confirmDialogEx(options: ConfirmOptions, requestId?: string): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    useDialogStore.setState((s) => ({
      queue: [...s.queue, { ...options, id: nextId++, ...(requestId ? { requestId } : {}), resolve }],
    }));
  });
}

/** Removes a request main withdrew (timed out, cancelled) without answering it. */
function dismissRequest(requestId: string): void {
  const item = useDialogStore.getState().queue.find((q) => q.requestId === requestId);
  if (item) useDialogStore.setState((s) => ({ queue: s.queue.filter((q) => q !== item) }));
}

/** Shows a confirmation dialog; resolves true on confirm. */
export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return (await confirmDialogEx(options)).confirmed;
}

/** Confirmations the main process asks (`ui:confirm`, e.g. quitting with running processes) use the same dialog. */
export function registerMainConfirmRequests(): void {
  ipc.on('ui:confirm', ({ requestId, ...options }) => {
    void confirmDialogEx(options, requestId).then(({ confirmed, checked, secondary, value }) =>
      ipc.invoke('ui:confirmResult', {
        requestId,
        confirmed,
        checked,
        ...(secondary ? { secondary } : {}),
        ...(value !== undefined ? { value } : {}),
      }),
    );
  });
  ipc.on('ui:confirmDismiss', ({ requestId }) => dismissRequest(requestId));
}
