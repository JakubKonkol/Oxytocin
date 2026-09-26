import { useDialogStore } from '../stores/dialog-store';
import { ConfirmDialog } from './ConfirmDialog';

/** Renders queued confirmation dialogs one at a time. */
export function DialogHost() {
  const current = useDialogStore((s) => s.queue[0]);
  const settle = useDialogStore((s) => s.settle);
  if (!current) return null;
  return (
    <ConfirmDialog
      key={current.id}
      open
      title={current.title}
      {...(current.description ? { description: current.description } : {})}
      {...(current.confirmLabel ? { confirmLabel: current.confirmLabel } : {})}
      {...(current.cancelLabel ? { cancelLabel: current.cancelLabel } : {})}
      destructive={current.destructive ?? false}
      onConfirm={() => settle(current.id, true)}
      onCancel={() => settle(current.id, false)}
    />
  );
}
