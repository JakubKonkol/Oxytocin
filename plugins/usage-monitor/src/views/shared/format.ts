/** Formatting shared by the Usage views. */

export const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

export const SOURCE_NAMES: Record<string, string> = {
  'claude-jsonl': 'Claude Code logs',
  'codex-rollout': 'Codex CLI rollouts',
  'gemini-chat': 'Gemini CLI chats',
};

export const agentName = (id: string) => AGENT_NAMES[id] ?? id;

/** "claude-opus-5-5" → "opus-5-5" (the agent already says Claude). */
export const shortModel = (model: string | null | undefined) => (model ? model.replace(/^claude-/, '') : '—');

/** $4.82 · <$0.01 · ≈ prefix for API-equivalent (subscription) amounts · "?" when the price is unknown. */
export function usd(
  value: number | null | undefined,
  opts: { approx?: boolean; precise?: boolean; unknown?: boolean } = {},
): string {
  if (value === null || value === undefined) return '?';
  const prefix = opts.approx ? '≈' : '';
  const text = opts.precise ? `$${value.toFixed(4)}` : value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
  return `${prefix}${text}${opts.unknown ? ' + ?' : ''}`;
}

/** 1.24M · 412k · 950 */
export function tokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 18 min · 1h 12m · 45 s */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Colour level of a limit bar (< 70 % ok, 70–90 % warning, ≥ 90 % danger). */
export function level(ratio: number): 'ok' | 'warning' | 'danger' {
  return ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : 'ok';
}

export const STATE_LABELS: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for you',
  idle: 'idle',
  starting: 'starting',
};
