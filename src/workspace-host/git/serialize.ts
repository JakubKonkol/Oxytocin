import { resolve } from 'node:path';

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after the previous write of the same repository finished. Writes take git's locks (`index.lock`),
 * so two of them at once would fail.
 */
export function serialized<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(repo).toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
