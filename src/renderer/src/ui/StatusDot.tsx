import { cn } from '../lib/cn';

export type StatusDotState = 'none' | 'idle' | 'running' | 'agent-working' | 'attention' | 'error';

export const STATUS_DOT_LABELS: Record<StatusDotState, string> = {
  none: 'No terminals',
  idle: 'Idle',
  running: 'Process running',
  'agent-working': 'Agent working',
  attention: 'Needs your attention',
  error: 'Process exited with an error',
};

export interface StatusDotProps {
  state: StatusDotState;
  size?: number;
  /** Tooltip / accessible description; defaults to the canonical state label. */
  title?: string;
  className?: string;
  testId?: string;
}

/** Activity indicator with state-specific animations (docs/plan/02-ui-ux.md §6). */
export function StatusDot({ state, size = 8, title, className, testId }: StatusDotProps) {
  const label = title ?? STATUS_DOT_LABELS[state];
  if (state === 'none') {
    return (
      <span aria-hidden className={cn('inline-block flex-none', className)} style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state={state}
      data-testid={testId}
      className={cn('oxy-dot', className)}
      style={{ width: size, height: size }}
    />
  );
}
