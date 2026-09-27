import { emptyTokens, type UsageRecord } from '../model';
import type { UsageTokens } from '../pricing/types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** OTLP/JSON `KeyValue[]` → plain record of string/number values. */
function attributes(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of arr(list)) {
    const o = obj(kv);
    const key = typeof o?.['key'] === 'string' ? o['key'] : undefined;
    const v = obj(o?.['value']);
    if (!key || !v) continue;
    const value = v['stringValue'] ?? v['intValue'] ?? v['doubleValue'] ?? v['boolValue'];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

const scalar = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const nanosToMs = (v: unknown): number => {
  try {
    return Number(BigInt(scalar(v) || '0') / 1_000_000n);
  } catch {
    return 0;
  }
};
const pointValue = (p: Json): number => Number(p['asDouble'] ?? p['asInt'] ?? 0) || 0;

/** What an OTLP export says about a session besides tokens (terminal/project attribution, reported cost). */
export interface OtlpSessionInfo {
  sessionId: string;
  agent: 'claude-code' | 'gemini-cli';
  terminalId?: string;
  projectId?: string;
  reportedCostUsd: number;
}

export interface OtlpBatch {
  records: UsageRecord[];
  sessions: OtlpSessionInfo[];
}

const AGGREGATION_CUMULATIVE = 2;

/**
 * Converts cumulative OTLP sums into deltas per stream (session × model × type × start time); delta streams pass
 * through. State survives across exports.
 */
export class CumulativeTracker {
  private readonly last = new Map<string, number>();

  delta(key: string, value: number, cumulative: boolean): number {
    if (!cumulative) return value;
    const prev = this.last.get(key);
    this.last.set(key, value);
    if (prev === undefined) return value;
    return value >= prev ? value - prev : value; // counter reset
  }
}

interface Accumulator {
  sessionId: string;
  model: string;
  ts: number;
  agent: 'claude-code' | 'gemini-cli';
  raw: Record<string, number>;
  cost: number;
}

/**
 * ExportMetricsServiceRequest (JSON) → usage records: Claude
 * `claude_code.token.usage` (type input/output/cacheRead/cacheCreation) and `claude_code.cost.usage`, Gemini
 * `gemini_cli.token.usage` (type input/output/thought/cache/tool; Google semantics as in §8).
 */
export function parseOtlpMetrics(body: unknown, tracker: CumulativeTracker): OtlpBatch {
  const acc = new Map<string, Accumulator>();
  const sessions = new Map<string, OtlpSessionInfo>();
  for (const rm of arr(obj(body)?.['resourceMetrics'])) {
    const resource = attributes(obj(obj(rm)?.['resource'])?.['attributes']);
    for (const sm of arr(obj(rm)?.['scopeMetrics'])) {
      for (const m of arr(obj(sm)?.['metrics'])) {
        const metric = obj(m);
        const name = scalar(metric?.['name']);
        const agent =
          name === 'claude_code.token.usage' || name === 'claude_code.cost.usage'
            ? ('claude-code' as const)
            : name === 'gemini_cli.token.usage'
              ? ('gemini-cli' as const)
              : null;
        if (!agent) continue;
        const sum = obj(metric?.['sum']);
        const cumulative = sum?.['aggregationTemporality'] === AGGREGATION_CUMULATIVE;
        for (const dp of arr(sum?.['dataPoints'])) {
          const p = obj(dp);
          if (!p) continue;
          const a = { ...resource, ...attributes(p['attributes']) };
          const sessionId = a['session.id'];
          if (!sessionId) continue;
          const model = a['model'] ?? 'unknown';
          const type = a['type'] ?? 'cost';
          const ts = nanosToMs(p['timeUnixNano']) || Date.now();
          const value = tracker.delta(
            `${name}|${sessionId}|${model}|${type}|${scalar(p['startTimeUnixNano'])}`,
            pointValue(p),
            cumulative,
          );
          const info = sessions.get(sessionId) ?? { sessionId, agent, reportedCostUsd: 0 };
          if (a['oxytocin.terminal_id']) info.terminalId = a['oxytocin.terminal_id'];
          if (a['oxytocin.project_id']) info.projectId = a['oxytocin.project_id'];
          sessions.set(sessionId, info);
          if (value <= 0) continue;
          const key = `${sessionId}|${model}|${ts}`;
          const entry = acc.get(key) ?? { sessionId, model, ts, agent, raw: {}, cost: 0 };
          if (name === 'claude_code.cost.usage') {
            entry.cost += value;
            info.reportedCostUsd += value;
          } else entry.raw[type] = (entry.raw[type] ?? 0) + value;
          acc.set(key, entry);
        }
      }
    }
  }
  const records: UsageRecord[] = [];
  for (const e of acc.values()) {
    const tokens: UsageTokens = emptyTokens();
    const r = (k: string) => Math.round(e.raw[k] ?? 0);
    if (e.agent === 'claude-code') {
      tokens.input = r('input');
      tokens.output = r('output');
      tokens.cacheRead = r('cacheRead');
      // The metric does not split 5-minute and 1-hour cache writes.
      tokens.cacheWrite5m = r('cacheCreation');
    } else {
      tokens.input = Math.max(0, r('input') - r('cache')) + r('tool');
      tokens.cacheRead = r('cache');
      tokens.output = r('output') + r('thought');
      tokens.reasoning = r('thought');
    }
    records.push({
      id: `${e.agent === 'claude-code' ? 'claude-otel' : 'gemini-otel'}:${e.sessionId}:${e.ts}:${e.model}`,
      ts: e.ts,
      agent: e.agent,
      provider: e.agent === 'claude-code' ? 'anthropic' : 'google',
      rawModel: e.model,
      sessionId: e.sessionId,
      tokens,
      reportedCostUsd: e.cost > 0 ? e.cost : null,
      source: e.agent === 'claude-code' ? 'claude-otel' : 'gemini-otel',
    });
  }
  return { records, sessions: [...sessions.values()] };
}
