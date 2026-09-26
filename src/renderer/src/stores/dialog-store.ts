import { create } from 'zustand';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

interface DialogStore {
  queue: PendingConfirm[];
  settle: (id: number, ok: boolean) => void;
}

let nextId = 1;

export const useDialogStore = create<DialogStore>((set, get) => ({
  queue: [],
  settle(id, ok) {
    const item = get().queue.find((q) => q.id === id);
    set({ queue: get().queue.filter((q) => q.id !== id) });
    item?.resolve(ok);
  },
}));

/** Shows a confirmation dialog (rendered by DialogHost); resolves true on confirm. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.setState((s) => ({ queue: [...s.queue, { ...options, id: nextId++, resolve }] }));
  });
}
