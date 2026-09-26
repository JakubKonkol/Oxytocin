import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeVariant = 'agent' | 'shell' | 'process' | 'active' | 'neutral' | 'warning' | 'danger';

const VARIANTS: Record<BadgeVariant, string> = {
  agent: 'text-agent border-agent/40 bg-agent/10',
  shell: 'text-fg-secondary border-line bg-transparent',
  process: 'text-success border-success/40 bg-success/10',
  active: 'text-line-focus border-line-focus/40 bg-accent-muted/40',
  neutral: 'text-fg-muted border-line bg-transparent',
  warning: 'text-warning border-warning/40 bg-warning/10',
  danger: 'text-danger border-danger/40 bg-danger/10',
};

export function Badge({
  variant = 'neutral',
  children,
  className,
  title,
  testId,
  dataState,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  title?: string;
  testId?: string;
  dataState?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      data-state={dataState}
      className={cn(
        'inline-flex h-4 flex-none items-center rounded-badge border px-1.5 font-mono text-[10px] leading-none tracking-[0.06em] uppercase',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
