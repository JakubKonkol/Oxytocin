import { useState } from 'react';
import { cn } from '../lib/cn';
import { type ConfirmOptions, useDialogStore } from '../stores/dialog-store';
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

/** The answer field of a dialog that asks something: options to pick, or free text. */
function DialogInput({
  input,
  value,
  onChange,
  onSubmit,
}: {
  input: NonNullable<ConfirmOptions['input']>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  if (input.kind === 'options')
    return (
      <div role="radiogroup" data-testid="dialog-options" className="flex flex-col gap-1">
        {input.options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            data-testid="dialog-option"
            onClick={() => onChange(option)}
            onDoubleClick={() => {
              onChange(option);
              onSubmit();
            }}
            className={cn(
              'rounded-control border px-3 py-1.5 text-left text-fg-secondary hover:bg-card-hover',
              value === option ? 'border-accent bg-accent-muted text-fg' : 'border-line-subtle',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    );
  return (
    <textarea
      data-testid="dialog-answer"
      autoFocus
      value={value}
      rows={3}
      placeholder={input.placeholder ?? 'Your answer'}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className="w-full resize-y rounded-control border border-line bg-input px-2 py-1.5 text-ui text-fg placeholder:text-fg-muted"
    />
  );
}

function PendingDialog() {
  const current = useDialogStore((s) => s.queue[0])!;
  const settle = useDialogStore((s) => s.settle);
  const [checked, setChecked] = useState(current.checkbox?.defaultChecked ?? false);
  const [value, setValue] = useState('');
  const answer = current.input ? { value: current.input.kind === 'text' ? value.trim() : value } : {};
  const confirm = () => settle(current.id, { confirmed: true, checked, ...answer });
  return (
    <ConfirmDialog
      open
      title={current.title}
      {...(current.description ? { description: current.description } : {})}
      {...(current.details ? { details: current.details } : {})}
      {...(current.tone ? { tone: current.tone } : {})}
      {...(current.confirmLabel ? { confirmLabel: current.confirmLabel } : {})}
      {...(current.cancelLabel ? { cancelLabel: current.cancelLabel } : {})}
      {...(current.code ? { code: current.code } : {})}
      {...(current.secondaryLabel
        ? {
            secondaryLabel: current.secondaryLabel,
            onSecondary: () => settle(current.id, { confirmed: true, checked, secondary: true }),
          }
        : {})}
      confirmDisabled={!!current.input && !value.trim()}
      destructive={current.destructive ?? false}
      onConfirm={confirm}
      onCancel={() => settle(current.id, { confirmed: false, checked })}
    >
      {current.input && (
        <DialogInput
          input={current.input}
          value={value}
          onChange={setValue}
          onSubmit={() => value.trim() && confirm()}
        />
      )}
      {current.checkbox && <DialogCheckbox label={current.checkbox.label} checked={checked} onChange={setChecked} />}
    </ConfirmDialog>
  );
}
