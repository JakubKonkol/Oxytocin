import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  shortcut?: string;
  icon: ReactNode;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, icon, active, className, type = 'button', ...rest },
  ref,
) {
  return (
    <Tooltip label={label} {...(shortcut ? { shortcut } : {})}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex size-6 flex-none items-center justify-center rounded-control text-fg-muted transition-colors',
          'hover:bg-card-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
          active && 'bg-card-hover text-fg',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
