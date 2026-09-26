import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-6 text-center', className)}>
      {icon && <div className="text-fg-muted">{icon}</div>}
      <div className="font-medium text-fg-secondary">{title}</div>
      {description && <div className="max-w-80 text-small text-fg-muted">{description}</div>}
      {actions && <div className="mt-2 flex gap-2">{actions}</div>}
    </div>
  );
}
