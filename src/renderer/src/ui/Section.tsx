import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  count?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}

/** Sidebar section header: mono uppercase label, optional counter and icon actions (card top). */
export function SectionHeader({ title, expanded, onToggle, count, actions, testId }: SectionHeaderProps) {
  return (
    <div
      data-testid={testId}
      data-expanded={expanded}
      className={cn(
        'group flex h-full items-center gap-1 border border-line-subtle bg-card pr-1.5 pl-2',
        expanded ? 'rounded-t-card border-b-0' : 'rounded-card',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 self-stretch text-left"
      >
        {expanded ? (
          <ChevronDown aria-hidden size={14} className="flex-none text-fg-muted" />
        ) : (
          <ChevronRight aria-hidden size={14} className="flex-none text-fg-muted" />
        )}
        <span className="oxy-label truncate">{title}</span>
        {count !== undefined && <span className="ml-1 font-mono text-small text-fg-muted">{count}</span>}
      </button>
      {actions && (
        <div
          className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/** Scrollable card body under a SectionHeader. */
export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-auto rounded-b-card border border-t-0 border-line-subtle bg-card px-2 pb-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
