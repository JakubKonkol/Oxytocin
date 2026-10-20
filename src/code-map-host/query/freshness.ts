/** Wait only for this reader. The operation continues for other readers after timeout or cancellation. */
export async function waitForCheckpoint(
  operation: Promise<void>,
  signal: AbortSignal,
  timeoutMs = 2000,
): Promise<boolean> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Code Map query cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
