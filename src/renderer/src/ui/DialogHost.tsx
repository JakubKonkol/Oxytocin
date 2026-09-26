import { useState } from 'react';
import { useDialogStore } from '../stores/dialog-store';
import { ConfirmDialog } from './ConfirmDialog';

function DialogCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-fg-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-(--accent)"
      />
      {label}
    </label>
  );
}

/** Renders queued confirmation dialogs one at a time. */
export function DialogHost() {
  const current = useDialogStore((s) => s.queue[0]);
  if (!current) return null;
  return <PendingDialog key={current.id} />;
}

function PendingDialog() {
  const current = useDialogStore((s) => s.queue[0])!;
  const settle = useDialogStore((s) => s.settle);
  const [checked, setChecked] = useState(current.checkbox?.defaultChecked ?? false);
  return (
    <ConfirmDialog
      open
      title={current.title}
      {...(current.description ? { description: current.description } : {})}
      {...(current.confirmLabel ? { confirmLabel: current.confirmLabel } : {})}
      {...(current.cancelLabel ? { cancelLabel: current.cancelLabel } : {})}
      destructive={current.destructive ?? false}
      onConfirm={() => settle(current.id, { confirmed: true, checked })}
      onCancel={() => settle(current.id, { confirmed: false, checked })}
    >
      {current.checkbox && <DialogCheckbox label={current.checkbox.label} checked={checked} onChange={setChecked} />}
    </ConfirmDialog>
  );
}
