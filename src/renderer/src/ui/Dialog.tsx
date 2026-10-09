import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { IconButton } from './IconButton';

/** A modal dialog: a title bar with a close button, a scrolling body and an optional footer of actions. */
export function AppDialog({
  title,
  icon,
  children,
  footer,
  onClose,
  testId,
  wide,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  testId: string;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oxy-dialog-overlay fixed inset-0 z-40 bg-app/70 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid={testId}
          aria-describedby={undefined}
          className={cn(
            'oxy-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-line bg-elevated shadow-elevated',
            wide ? 'w-[860px]' : 'w-[560px]',
          )}
        >
          <div className="flex flex-none items-center gap-2.5 border-b border-line-subtle px-4 py-3">
            {icon}
            <Dialog.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{title}</Dialog.Title>
            <IconButton label="Close" icon={<X size={14} />} onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
          {footer && (
            <div className="flex flex-none items-center gap-2 border-t border-line-subtle bg-card px-4 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
