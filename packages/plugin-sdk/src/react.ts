import { useEffect, useState, useSyncExternalStore } from 'react';
import { connect, type OxyView } from './index';

let shared: Promise<OxyView<unknown, unknown>> | undefined;

/** Connects once per page; returns the view when ready (null while connecting). */
export function useOxyView<P = unknown, S = unknown>(): OxyView<P, S> | null {
  const [view, setView] = useState<OxyView<P, S> | null>(null);
  useEffect(() => {
    let alive = true;
    shared ??= connect();
    void shared.then((v) => {
      if (alive) setView(v as OxyView<P, S>);
    });
    return () => {
      alive = false;
    };
  }, []);
  return view;
}

/** The latest message from the backend (optionally filtered). */
export function useOxyMessage<T = unknown>(view: OxyView | null, filter?: (msg: unknown) => msg is T): T | undefined {
  const [message, setMessage] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (!view) return;
    return view.onMessage((msg) => {
      if (!filter || filter(msg)) setMessage(msg as T);
    });
  }, [view, filter]);
  return message;
}

const readTheme = (): 'dark' | 'light' => (document.documentElement.dataset['oxyTheme'] === 'light' ? 'light' : 'dark');
const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-oxy-theme'] });
  return () => observer.disconnect();
};

/**
 * The shell's current theme ("dark" or "light"), re-rendering on switches (the tokens are already applied).
 * Components that read token values imperatively (charts, canvases) should depend on it.
 */
export function useOxyTheme(): 'dark' | 'light' {
  return useSyncExternalStore(subscribeTheme, readTheme);
}
