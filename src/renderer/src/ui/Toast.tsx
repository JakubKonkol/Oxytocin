import { toast, Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={{ bottom: 32, right: 12 }}
      theme="dark"
      toastOptions={{
        style: {
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 'var(--font-size-ui)',
        },
      }}
    />
  );
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface NotifyOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  /** A second, quieter button that also closes the toast. */
  cancel?: { label: string; onClick: () => void };
  id?: string;
  /** Milliseconds; warnings and errors stay longer by default. */
  duration?: number;
}

/** Shows an in-app toast. */
export function notify(kind: ToastKind, message: string, opts: NotifyOptions = {}): void {
  toast[kind](message, { duration: kind === 'warning' || kind === 'error' ? 10_000 : 4_000, ...opts });
}

let nextActionToast = 1;

/**
 * A toast with up to three buttons (e.g. a plugin's question). `onDone` gets the clicked button's id, or null when
 * the toast was closed or timed out; it is called exactly once.
 */
export function notifyWithActions(
  kind: ToastKind,
  message: string,
  opts: {
    description?: string;
    actions: readonly { id: string; title: string }[];
    onDone: (actionId: string | null) => void;
    duration?: number;
  },
): void {
  const id = `actions-${nextActionToast++}`;
  let done = false;
  const finish = (actionId: string | null) => {
    if (done) return;
    done = true;
    opts.onDone(actionId);
  };
  toast[kind](message, {
    id,
    duration: opts.duration ?? 30_000,
    description: (
      <div className="flex flex-col gap-2">
        {opts.description && <div className="whitespace-pre-wrap">{opts.description}</div>}
        <div className="flex flex-wrap gap-1.5" data-testid="toast-actions">
          {opts.actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              data-testid={`toast-action-${a.id}`}
              className={
                i === 0
                  ? 'h-6 rounded-control border border-transparent bg-accent px-2 text-small font-medium text-fg-inverse hover:brightness-110'
                  : 'h-6 rounded-control border border-line bg-elevated px-2 text-small font-medium text-fg hover:bg-card-hover'
              }
              onClick={() => {
                finish(a.id);
                toast.dismiss(id);
              }}
            >
              {a.title}
            </button>
          ))}
        </div>
      </div>
    ),
    onDismiss: () => finish(null),
    onAutoClose: () => finish(null),
  });
}
