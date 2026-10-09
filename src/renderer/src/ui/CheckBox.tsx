import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type CheckState = 'all' | 'some' | 'none';

const ariaChecked = (state: CheckState) => (state === 'all' ? true : state === 'some' ? 'mixed' : false);

/** The box of a tri-state checkbox (accent fill when checked, a dash when only partly). */
export function CheckMark({ state }: { state: CheckState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-3.5 flex-none items-center justify-center rounded-[3px] border transition-colors',
        state === 'none' ? 'border-line-strong bg-input' : 'border-accent bg-accent text-fg-inverse',
      )}
    >
      {state === 'all' && <Check size={10} strokeWidth={3} />}
      {state === 'some' && <Minus size={10} strokeWidth={3} />}
    </span>
  );
}

/** A compact tri-state checkbox (rows of lists: staged files). Clicks do not reach the row. */
export function CheckBox({
  state,
  onToggle,
  label,
  title,
  testId,
}: {
  state: CheckState;
  onToggle: () => void;
  label: string;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked(state)}
      aria-label={label}
      title={title ?? label}
      data-testid={testId}
      data-state={state}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="group/check flex size-4 flex-none items-center justify-center rounded-badge hover:[&>span]:border-accent"
    >
      <CheckMark state={state} />
    </button>
  );
}

/** A checkbox with a label in a toolbar (diff and review headers): "Staged", "Viewed". */
export function CheckPill({
  state,
  onToggle,
  children,
  title,
  testId,
}: {
  state: CheckState;
  onToggle: () => void;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked(state)}
      title={title}
      data-testid={testId}
      data-state={state}
      onClick={onToggle}
      className={cn(
        'flex h-6 flex-none items-center gap-1.5 rounded-control border px-1.5 text-small transition-colors hover:bg-card-hover',
        state === 'all' ? 'border-accent/60 text-fg' : 'border-line-subtle text-fg-secondary',
      )}
    >
      <CheckMark state={state} />
      {children}
    </button>
  );
}
