import { FlaskConical, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn';
import { Badge } from './Badge';

/** A feature in beta (Ensemble, Code Map): the badge next to its name. */
export function BetaBadge({ feature, testId, className }: { feature: string; testId?: string; className?: string }) {
  return (
    <Badge
      variant="warning"
      title={`${feature} is in beta: not fully tested yet`}
      {...(testId ? { testId } : {})}
      {...(className ? { className } : {})}
    >
      Beta
    </Badge>
  );
}

/** Notices closed in this session (shown again after a restart). */
const closedNotices = new Set<string>();

/** The notice at the top of a beta feature's panel or settings; `id` remembers that it was closed. */
export function BetaNotice({
  id,
  feature,
  children,
  testId,
  className,
}: {
  id: string;
  feature: string;
  children: ReactNode;
  testId?: string;
  /** Replaces the full-width banner look (border below, wide padding), e.g. with a framed box. */
  className?: string;
}) {
  const [closed, setClosed] = useState(() => closedNotices.has(id));
  if (closed) return null;
  return (
    <div
      role="note"
      data-testid={testId}
      className={cn(
        'flex flex-none items-start gap-2 border-warning/40 bg-warning/10 py-2 text-small text-fg-secondary',
        className ?? 'border-b px-4',
      )}
    >
      <FlaskConical size={14} className="mt-0.5 flex-none text-warning" />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold text-fg">{feature} is in beta.</strong> {children}
      </span>
      <button
        type="button"
        aria-label="Close the beta notice"
        {...(testId ? { 'data-testid': `${testId}-close` } : {})}
        onClick={() => {
          closedNotices.add(id);
          setClosed(true);
        }}
        className="flex-none rounded-badge p-0.5 text-fg-muted hover:bg-card-hover hover:text-fg"
      >
        <X size={13} />
      </button>
    </div>
  );
}
