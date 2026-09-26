import { cn } from '../lib/cn';

export interface ProgressBarProps {
  /** 0…1 (values above 1 are shown full, in the danger color). */
  value: number;
  warnAt?: number;
  dangerAt?: number;
  label?: string;
  className?: string;
}

export function progressTone(value: number, warnAt = 0.8, dangerAt = 1): 'ok' | 'warn' | 'danger' {
  if (value >= dangerAt) return 'danger';
  if (value >= warnAt) return 'warn';
  return 'ok';
}

const TONE_CLASS = { ok: 'bg-line-focus', warn: 'bg-warning', danger: 'bg-danger' } as const;

export function ProgressBar({ value, warnAt = 0.8, dangerAt = 1, label, className }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const tone = progressTone(value, warnAt, dangerAt);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      data-tone={tone}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-input', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', TONE_CLASS[tone])}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}
