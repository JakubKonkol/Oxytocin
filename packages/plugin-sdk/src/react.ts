import { useEffect, useState } from 'react';
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
