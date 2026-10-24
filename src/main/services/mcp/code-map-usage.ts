import type { CodeMapUsageRange, CodeMapUsageResult, CodeMapUsageTotals } from '@shared/domain/code-map-usage';
import type { McpToolResult } from '@shared/domain/mcp';

/** What a Code Map tool reports about its own answer, decided on the structured result rather than on the text. */
export interface CodeMapAnswerReport {
  /** The answer carried a `stale:` line. */
  stale?: boolean;
  /** The answer was not OK (`INDEX_UPDATING`, `NOT_FOUND`, …). */
  notOk?: boolean;
}

export interface CodeMapCallRecord {
  sessionId: string;
  terminalId?: string | undefined;
  projectId?: string | undefined;
  tool: string;
  at: number;
  result: McpToolResult;
  failed: boolean;
  report?: CodeMapAnswerReport | undefined;
}

/** One MCP session's Code Map use. Counts only. */
export interface CodeMapSessionUsage extends CodeMapUsageTotals {
  /** The MCP session id the transport made up (not a Claude Code session id). */
  sessionId: string;
  terminalId: string | null;
  projectId: string | null;
  firstAt: number;
  lastAt: number;
  /** Per tool: the same counters. */
  tools: Record<string, CodeMapUsageTotals>;
}

/** [at, chars, flags] — what is needed to total a time range; flags: 1 stale, 2 not OK, 4 error. */
type CallEvent = readonly [at: number, chars: number, flags: number];

interface Entry extends CodeMapSessionUsage {
  events: CallEvent[];
}

export const MAX_USAGE_SESSIONS = 200;
export const MAX_USAGE_EVENTS_PER_SESSION = 400;

const zero = (): CodeMapUsageTotals => ({ calls: 0, chars: 0, stale: 0, notOk: 0, errors: 0 });
const add = (into: CodeMapUsageTotals, chars: number, flags: number) => {
  into.calls++;
  into.chars += chars;
  if (flags & 1) into.stale++;
  if (flags & 2) into.notOk++;
  if (flags & 4) into.errors++;
};

/** Characters of the text the agent receives (images count nothing). */
export function resultChars(result: McpToolResult): number {
  let n = 0;
  for (const part of result.content) if (part.type === 'text') n += part.text.length;
  return n;
}

/**
 * Per MCP session counters of Code Map tool calls, in memory (reset on restart): at most {@link MAX_USAGE_SESSIONS}
 * sessions (the least recently used one goes first), each with at most {@link MAX_USAGE_EVENTS_PER_SESSION} call
 * timestamps for range totals. Nothing a call carried is stored besides the tool name.
 */
export class CodeMapUsage {
  private readonly sessions = new Map<string, Entry>();

  record(call: CodeMapCallRecord): void {
    const entry: Entry = this.sessions.get(call.sessionId) ?? {
      sessionId: call.sessionId,
      terminalId: null,
      projectId: null,
      firstAt: call.at,
      lastAt: call.at,
      ...zero(),
      tools: {},
      events: [],
    };
    // Re-insert: Map order is the recency order.
    this.sessions.delete(call.sessionId);
    this.sessions.set(call.sessionId, entry);
    while (this.sessions.size > MAX_USAGE_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);

    const chars = resultChars(call.result);
    const flags = (call.report?.stale ? 1 : 0) | (call.report?.notOk ? 2 : 0) | (call.failed ? 4 : 0);
    entry.terminalId ??= call.terminalId ?? null;
    entry.projectId ??= call.projectId ?? null;
    entry.firstAt = Math.min(entry.firstAt, call.at);
    entry.lastAt = Math.max(entry.lastAt, call.at);
    add(entry, chars, flags);
    add((entry.tools[call.tool] ??= zero()), chars, flags);
    entry.events.push([call.at, chars, flags]);
    if (entry.events.length > MAX_USAGE_EVENTS_PER_SESSION)
      entry.events.splice(0, entry.events.length - MAX_USAGE_EVENTS_PER_SESSION);
  }

  /** The sessions, most recently active first. */
  snapshot(): CodeMapSessionUsage[] {
    return [...this.sessions.values()].reverse().map(({ events: _events, tools, ...rest }) => ({
      ...rest,
      tools: Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, { ...t }])),
    }));
  }

  /** Totals of the calls terminals made in time ranges (inclusive). */
  totals(ranges: readonly CodeMapUsageRange[]): CodeMapUsageResult {
    const result: CodeMapUsageResult = {};
    for (const range of ranges) {
      const sum = zero();
      for (const entry of this.sessions.values()) {
        if (entry.terminalId !== range.terminalId || entry.lastAt < range.from || entry.firstAt > range.to) continue;
        for (const [at, chars, flags] of entry.events) if (at >= range.from && at <= range.to) add(sum, chars, flags);
      }
      if (sum.calls > 0) result[range.key] = sum;
    }
    return result;
  }

  clear(): void {
    this.sessions.clear();
  }
}
