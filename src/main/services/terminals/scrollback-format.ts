/**
 * Wraps a serialized buffer for a revived terminal: resets modes a full-screen app may have left behind and
 * appends a dimmed separator line (e.g. "── Session restored · … ──" or "── Restarted ──").
 */
export function withSeparator(snapshot: string, label: string): string {
  // `CSI ?1049l` also restores the saved cursor, so only emit it when the snapshot entered the alternate screen.
  const leaveAlt = snapshot.includes('\x1b[?1049h') ? '\x1b[?1049l' : '';
  const reset = `\x1b[0m${leaveAlt}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l`;
  return `${snapshot}${reset}\r\n\x1b[2m── ${label} ──\x1b[0m\r\n`;
}
