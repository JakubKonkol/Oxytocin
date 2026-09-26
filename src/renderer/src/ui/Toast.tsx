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
  id?: string;
  /** Milliseconds; warnings and errors stay longer by default. */
  duration?: number;
}

/** Shows an in-app toast. */
export function notify(kind: ToastKind, message: string, opts: NotifyOptions = {}): void {
  toast[kind](message, { duration: kind === 'warning' || kind === 'error' ? 10_000 : 4_000, ...opts });
}
