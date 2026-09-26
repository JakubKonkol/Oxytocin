import { homedir } from 'node:os';
import { join } from 'node:path';
import { type CollectedItem, emptyTokens } from '../model';

const MARKERS = ['"token_count"', '"session_meta"', '"turn_context"'].map((m) => Buffer.from(m));
export const acceptCodexLine = (line: Buffer): boolean => MARKERS.some((m) => line.includes(m));

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Totals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

function totals(u: Json | undefined): Totals | undefined {
  if (!u) return undefined;
  return {
    input: int(u['input_tokens']),
    cached: int(u['cached_input_tokens']),
    output: int(u['output_tokens']),
    reasoning: int(u['reasoning_output_tokens']),
    total: int(u['total_tokens']),
  };
}

/** Per-file state kept in the cursor. */
export interface CodexState {
  sessionId?: string;
  cwd?: string;
  model?: string;
  serviceTier?: string;
  startedAt?: number;
  prev?: Totals;
}

/**
 * One rollout line (docs/plan/08-usage-monitor.md §7; format S7): session and model context, and `token_count`
 * events turned into deltas of the cumulative totals (duplicates skipped, resets use `last_token_usage`).
 */
export function parseCodexLine(text: string, state: CodexState, fileId: string): CollectedItem[] {
  let o: Json;
  try {
    o = JSON.parse(text) as Json;
  } catch {
    return [];
  }
  const payload = obj(o['payload']) ?? {};
  const ts = Date.parse(String(o['timestamp']));
  if (o['type'] === 'session_meta') {
    if (typeof payload['id'] === 'string') state.sessionId = payload['id'];
    if (typeof payload['cwd'] === 'string') state.cwd = payload['cwd'];
    const started = Date.parse(String(payload['timestamp'] ?? o['timestamp']));
    if (Number.isFinite(started)) state.startedAt = started;
    return [];
  }
  if (o['type'] === 'turn_context') {
    if (typeof payload['model'] === 'string') state.model = payload['model'];
    if (typeof payload['cwd'] === 'string') state.cwd = payload['cwd'];
    if (typeof payload['service_tier'] === 'string') state.serviceTier = payload['service_tier'];
    return [];
  }
  if (o['type'] !== 'event_msg' || payload['type'] !== 'token_count' || !Number.isFinite(ts)) return [];
  const items: CollectedItem[] = [];
  const limits = obj(payload['rate_limits']);
  for (const window of ['primary', 'secondary']) {
    const l = obj(limits?.[window]);
    if (!l) continue;
    const resetsAt = numOrNull(l['resets_at']);
    const resetsIn = numOrNull(l['resets_in_seconds']);
    items.push({
      kind: 'limit',
      agent: 'codex',
      window,
      usedPercent: numOrNull(l['used_percent']),
      windowMinutes: numOrNull(l['window_minutes']),
      // Seconds since the epoch (or relative seconds in older versions).
      resetsAt:
        resetsAt !== null
          ? resetsAt < 1e12
            ? resetsAt * 1000
            : resetsAt
          : resetsIn !== null
            ? ts + resetsIn * 1000
            : null,
      observedAt: ts,
    });
  }
  const info = obj(payload['info']);
  const total = totals(obj(info?.['total_token_usage']));
  if (!total) return items;
  const prev = state.prev;
  if (prev && total.total === prev.total) return items;
  let delta: Totals;
  if (!prev) delta = total;
  else if (total.total > prev.total)
    delta = {
      input: Math.max(0, total.input - prev.input),
      cached: Math.max(0, total.cached - prev.cached),
      output: Math.max(0, total.output - prev.output),
      reasoning: Math.max(0, total.reasoning - prev.reasoning),
      total: total.total - prev.total,
    };
  else delta = totals(obj(info?.['last_token_usage'])) ?? total; // reset (e.g. compaction)
  state.prev = total;
  const sessionId = state.sessionId ?? fileId;
  const tokens = emptyTokens();
  // OpenAI semantics: input includes cached input, output includes reasoning.
  tokens.input = Math.max(0, delta.input - delta.cached);
  tokens.cacheRead = delta.cached;
  tokens.output = delta.output;
  tokens.reasoning = delta.reasoning;
  items.push({
    id: `codex:${sessionId}:${total.total}`,
    ts,
    agent: 'codex',
    provider: 'openai',
    rawModel: state.model ?? 'unknown',
    sessionId,
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.startedAt ? { sessionStartedAt: state.startedAt } : {}),
    tokens,
    extras: state.serviceTier ? { serviceTier: state.serviceTier } : {},
    source: 'codex-rollout',
  });
  return items;
}

/** `${CODEX_HOME ?? ~/.codex}/sessions` first (it wins over the same file in `archived_sessions`). */
export function codexRoots(env: NodeJS.ProcessEnv, home = homedir()): string[] {
  const base = env['CODEX_HOME'] || join(home, '.codex');
  return [join(base, 'sessions'), join(base, 'archived_sessions')];
}

export const isCodexRollout = (path: string): boolean => /rollout-[^\\/]*\.jsonl$/.test(path);

/** The same rollout in sessions/ and archived_sessions/ → one key. */
export const codexDedupeKey = (path: string): string | null =>
  path.replace(/\\/g, '/').replace(/^.*\/(archived_sessions|sessions)\//, '') || null;
