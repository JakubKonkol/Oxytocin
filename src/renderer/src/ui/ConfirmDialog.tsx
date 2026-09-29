import { AlertDialog } from 'radix-ui';
import { AlertTriangle, Info, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';

export type ConfirmTone = 'info' | 'warning' | 'danger';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Items the confirmation is about (running processes, affected files…), shown as a list. */
  details?: readonly string[];
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Icon and colour of the dialog (default: `danger` when destructive, else `info`). */
  tone?: ConfirmTone;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

const TONES: Record<ConfirmTone, { icon: ReactNode; className: string }> = {
  info: { icon: <Info size={18} />, className: 'bg-accent/15 text-accent' },
  warning: { icon: <AlertTriangle size={18} />, className: 'bg-warning/15 text-warning' },
  danger: { icon: <Trash2 size={17} />, className: 'bg-danger/15 text-danger' },
};

/** Confirmation dialog; destructive variant has a red confirm button and focuses "Cancel" by default. */
export function ConfirmDialog({
  open,
  title,
  description,
  details,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  tone = destructive ? 'danger' : 'info',
  children,
  onConfirm,
  onCancel,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  const { icon, className } = TONES[tone];
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="oxy-dialog-overlay fixed inset-0 z-40 bg-app/70 backdrop-blur-[2px]" />
        <AlertDialog.Content
          data-testid={testId}
          className="oxy-dialog fixed top-1/2 left-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-line bg-elevated shadow-elevated"
        >
          <div className="flex gap-3.5 p-5 pb-4">
            <div
              aria-hidden
              className={cn('flex size-9 flex-none items-center justify-center rounded-full', className)}
            >
              {icon}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <AlertDialog.Title className="text-[15px] leading-snug font-semibold text-fg">{title}</AlertDialog.Title>
              {description ? (
                <AlertDialog.Description className="mt-1.5 leading-relaxed text-fg-secondary">
                  {description}
                </AlertDialog.Description>
              ) : (
                <AlertDialog.Description className="sr-only">{title}</AlertDialog.Description>
              )}
              {details && details.length > 0 && (
                <ul
                  data-testid="confirm-dialog-details"
                  className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-control border border-line-subtle bg-card px-3 py-2 text-small text-fg-secondary"
                >
                  {details.map((d, i) => (
                    <li key={i} className="truncate" title={d}>
                      {d}
                    </li>
                  ))}
                </ul>
              )}
              {children && <div className="mt-3">{children}</div>}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-line-subtle bg-surface/60 px-5 py-3">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" autoFocus={destructive}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? 'danger' : 'primary'} autoFocus={!destructive} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
