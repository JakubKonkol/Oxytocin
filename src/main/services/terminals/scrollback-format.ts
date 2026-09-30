/** Label of the separator below a scrollback restored at start-up ("Session restored · Sep 26, 2026, 6:42 PM"). */
export function sessionRestoredLabel(at: Date): string {
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  return `Session restored · ${when}`;
}
