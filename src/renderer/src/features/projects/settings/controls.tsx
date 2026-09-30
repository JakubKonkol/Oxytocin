import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { ResourceTestResult } from '@shared/domain/project-resources';
import { cn } from '../../../lib/cn';
import { Button } from '../../../ui/Button';

export const input =
  'h-7 w-full rounded-control border border-line bg-input px-2 text-ui text-fg placeholder:text-fg-muted';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-small font-medium text-fg-secondary">{label}</span>
      {children}
      {hint && <span className="text-small text-fg-muted">{hint}</span>}
    </label>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-line-subtle pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center">
        <h3 className="oxy-label flex-1">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Check({
  checked,
  onChange,
  children,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex items-center gap-2 text-fg-secondary', disabled && 'opacity-50')}>
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/** A row of mutually exclusive buttons (keyboard: Tab to the group, arrows move). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T;
  options: { value: T; label: string; tone?: 'warning' | 'danger' }[];
  onChange: (v: T) => void;
  label: string;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="inline-flex w-fit self-start rounded-control border border-line p-0.5"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-value={o.value}
          tabIndex={value === o.value ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
            onChange(next.value);
          }}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-badge px-2 py-0.5 text-small',
            value === o.value
              ? o.tone === 'danger'
                ? 'bg-danger text-fg'
                : o.tone === 'warning'
                  ? 'bg-warning text-fg-inverse'
                  : 'bg-accent text-fg-inverse'
              : 'text-fg-secondary hover:bg-card-hover',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A secret: never shown. Set secrets read "••••••" with Change / Remove; a typed value is sent to the secret store
 * on save (write-only).
 */
export function SecretInput({
  label,
  state,
  onSet,
  onRemove,
  onReset,
  testId,
  placeholder,
  hint,
}: {
  label: string;
  state: 'set' | 'unset' | 'changed' | 'imported';
  onSet: (value: string) => void;
  onRemove: () => void;
  onReset: () => void;
  testId: string;
  placeholder?: string;
  hint?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const id = useId();
  const showInput = editing || state === 'unset' || state === 'changed';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-small font-medium text-fg-secondary">
        {label}
      </label>
      {showInput ? (
        <div className="flex gap-1.5">
          <input
            id={id}
            type="password"
            data-testid={testId}
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={placeholder ?? (state === 'unset' ? 'Not set' : 'New value')}
            onChange={(e) => {
              setValue(e.target.value);
              if (e.target.value) onSet(e.target.value);
              else onReset();
            }}
            className={cn(input, 'font-mono')}
          />
          {editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue('');
                onReset();
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5" data-testid={`${testId}-state`} data-state={state}>
          <span className="flex-1 font-mono text-fg-secondary">
            {state === 'imported' ? 'from the import' : '••••••'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" data-testid={`${testId}-remove`} onClick={onRemove}>
            Remove
          </Button>
        </div>
      )}
      {hint && <span className="text-small text-fg-muted">{hint}</span>}
    </div>
  );
}

const ERROR_TITLES: Record<string, string> = {
  auth: 'Authentication failed',
  unreachable: 'Host unreachable',
  tls: 'TLS problem',
  database: 'Database not found',
  timeout: 'Timed out',
  config: 'Incomplete settings',
  http: 'HTTP error',
  unsupported: 'Not supported',
  other: 'Failed',
};

export function TestConnection({ run, testId }: { run: () => Promise<ResourceTestResult>; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResourceTestResult | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <Button
          size="sm"
          data-testid={testId}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setResult(null);
            void run()
              .then(setResult, (e: unknown) =>
                setResult({ ok: false, error: { kind: 'other', message: e instanceof Error ? e.message : String(e) } }),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : null} Test connection
        </Button>
      </div>
      {result && (
        <div
          data-testid={`${testId}-result`}
          data-ok={result.ok}
          role="status"
          className={cn(
            'flex gap-2 rounded-control border px-2 py-1.5 text-small',
            result.ok ? 'border-success text-fg' : 'border-danger text-fg',
          )}
        >
          {result.ok ? (
            <CheckCircle2 size={14} className="mt-0.5 flex-none text-success" />
          ) : (
            <XCircle size={14} className="mt-0.5 flex-none text-danger" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {result.ok
                ? `Connected — ${result.serverVersion ?? ''}`
                : (ERROR_TITLES[result.error?.kind ?? 'other'] ?? 'Failed')}
              {result.latencyMs !== undefined && (
                <span className="ml-2 font-normal text-fg-muted">{result.latencyMs} ms</span>
              )}
            </div>
            {!result.ok && result.error && (
              <div className="whitespace-pre-wrap break-words text-fg-secondary">{result.error.message}</div>
            )}
            {result.details?.map((d) => (
              <div key={d} className="text-fg-secondary">
                {d}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Master–detail list on the left of the Databases and APIs tabs. */
export function ResourceList<T extends { id: string; name: string }>({
  items,
  selected,
  onSelect,
  describe,
  testId,
  empty,
}: {
  items: T[];
  selected: string | null;
  onSelect: (id: string) => void;
  describe: (item: T) => string;
  testId: string;
  empty: string;
}) {
  return (
    <div
      role="listbox"
      aria-label="Resources"
      data-testid={testId}
      className="flex w-48 flex-none flex-col gap-0.5 overflow-auto border-r border-line-subtle pr-2"
    >
      {items.length === 0 && <div className="py-1 text-small text-fg-muted">{empty}</div>}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={selected === item.id}
          data-testid={`${testId}-item`}
          data-name={item.name}
          onClick={() => onSelect(item.id)}
          className={cn(
            'flex flex-col items-start rounded-control px-2 py-1 text-left',
            selected === item.id ? 'bg-focus-tint text-fg' : 'text-fg-secondary hover:bg-card-hover',
          )}
        >
          <span className="w-full truncate text-ui">{item.name}</span>
          <span className="w-full truncate text-small text-fg-muted">{describe(item)}</span>
        </button>
      ))}
    </div>
  );
}

/** The one-sentence honest limit of the bridge. */
export function BridgeNote() {
  return (
    <p className="text-small text-fg-muted" data-testid="bridge-note">
      Oxytocin controls what agents do through its tools; an agent with a shell could still use credentials it finds in
      the project itself, so the bridge is the safe path, not a sandbox.
    </p>
  );
}
