/** The program drew the paste and then stayed quiet this long before Enter follows. */
export const PASTE_QUIET_MS = 250;

/**
 * When to press Enter after typing a paste into a program. A fixed pause is not enough: Codex CLI on Windows reads a
 * long paste key by key through ConPTY (60,000 characters take about 15 s, silently) and an Enter that arrives
 * mid-paste becomes part of the text, leaving the prompt unsent. Enter follows once the program drew something after
 * the paste and then stayed quiet for a moment, or after a deadline that grows with the length.
 */
export function pasteSubmitDue(o: {
  /** When the last slice of the paste was written. */
  writtenAt: number;
  /** The program's last output. */
  lastOutputAt: number;
  now: number;
  /** Characters written. */
  length: number;
  /** The shortest pause before Enter. */
  minDelayMs?: number;
}): boolean {
  const elapsed = o.now - o.writtenAt;
  if (elapsed >= pasteSubmitDeadlineMs(o.length)) return true;
  return elapsed >= (o.minDelayMs ?? 150) && o.lastOutputAt > o.writtenAt && o.now - o.lastOutputAt >= PASTE_QUIET_MS;
}

/** Enter follows at the latest this long after a silent paste of `length` characters. */
export function pasteSubmitDeadlineMs(length: number): number {
  return Math.min(60_000, 1500 + Math.floor(length / 2));
}
