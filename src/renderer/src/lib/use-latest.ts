import { useLayoutEffect, useRef } from 'react';

/** A ref that always holds the latest value (for callbacks registered once, e.g. in an editor). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
