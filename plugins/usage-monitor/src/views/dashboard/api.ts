import type { OxyView } from '@oxytocin/plugin-sdk';
import { createContext, useContext, useEffect, useState } from 'react';

export const ViewContext = createContext<OxyView | null>(null);
/** Increments whenever the backend reports new data (`changed`). */
export const RevisionContext = createContext(0);

/** Loads `method` from the backend and reloads it when data changes. */
export function useRequest<T>(
  method: string,
  params?: unknown,
): { data: T | null; error: string | null; reload: () => void } {
  const view = useContext(ViewContext);
  const revision = useContext(RevisionContext);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(params ?? null);
  useEffect(() => {
    if (!view) return;
    let alive = true;
    view.request<T>(method, key === 'null' ? undefined : JSON.parse(key)).then(
      (result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [view, method, key, revision, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export function useView(): OxyView {
  return useContext(ViewContext)!;
}
