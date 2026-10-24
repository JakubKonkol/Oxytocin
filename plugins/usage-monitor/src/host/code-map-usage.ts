/**
 * "Code Map calls" per agent session: what Code Map cost the session, next to its tokens and cost.
 *
 * Oxytocin's MCP Hub counts the Code Map tool calls of each terminal's agent (counts only, in memory, since the app
 * started). A usage session knows its terminal when it runs in an Oxytocin terminal, so its figure is the calls that
 * terminal made between the session's first and last event.
 */

/** The core command (`CODE_MAP_USAGE_COMMAND` in the app): `{ ranges }` → totals by range key. */
export const CODE_MAP_USAGE_COMMAND = 'oxytocin.mcp.codeMapUsage';

/** Calls are logged before the usage event that follows their answer, and a log file can lag a little. */
export const ATTRIBUTION_SLACK_MS = 30_000;
const MAX_RANGES = 200;

export interface CodeMapFigure {
  calls: number;
  chars: number;
  stale: number;
  notOk: number;
  errors: number;
}

interface SessionLike {
  sessionId: string;
  terminalId: string | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
}

const isFigure = (v: unknown): v is CodeMapFigure =>
  typeof v === 'object' &&
  v !== null &&
  (['calls', 'chars', 'stale', 'notOk', 'errors'] as const).every((k) => Number.isFinite((v as CodeMapFigure)[k]));

/**
 * Adds `codeMap` to the sessions that ran in a terminal: the totals, or zeros when the session happened while Oxytocin
 * was counting (`trackedSince`) and made no call. `null` means unknown: no terminal, or it ended before counting began.
 */
export async function withCodeMapUsage<T extends SessionLike>(
  rows: readonly T[],
  execute: (id: string, ...args: unknown[]) => Promise<unknown>,
  trackedSince: number,
): Promise<(T & { codeMap: CodeMapFigure | null })[]> {
  const ranges = rows
    .filter((r) => r.terminalId && r.firstEventAt !== null && r.lastEventAt !== null)
    .slice(0, MAX_RANGES)
    .map((r) => ({
      key: r.sessionId,
      terminalId: r.terminalId!,
      from: r.firstEventAt! - ATTRIBUTION_SLACK_MS,
      to: r.lastEventAt! + ATTRIBUTION_SLACK_MS,
    }));
  let totals: Record<string, unknown> = {};
  if (ranges.length > 0) {
    try {
      const answer = await execute(CODE_MAP_USAGE_COMMAND, { ranges });
      if (typeof answer === 'object' && answer !== null) totals = answer as Record<string, unknown>;
    } catch {
      // An older app without the command, or Code Map unavailable: the column stays empty.
      return rows.map((r) => ({ ...r, codeMap: null }));
    }
  }
  const counted = new Set(ranges.map((r) => r.key));
  return rows.map((r) => {
    const found = Object.hasOwn(totals, r.sessionId) ? totals[r.sessionId] : undefined;
    const codeMap = isFigure(found)
      ? found
      : counted.has(r.sessionId) && (r.lastEventAt ?? 0) >= trackedSince
        ? { calls: 0, chars: 0, stale: 0, notOk: 0, errors: 0 }
        : null;
    return { ...r, codeMap };
  });
}
