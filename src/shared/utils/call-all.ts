/** Calls every listener, also when one throws; the first error is rethrown once all have run. */
export function callAll<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  let failed = false;
  let error: unknown;
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (e) {
      if (!failed) error = e;
      failed = true;
    }
  }
  if (failed) throw error;
}
