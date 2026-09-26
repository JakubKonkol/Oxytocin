import type { UsageExtras, UsageTokens } from './pricing/types';

export type UsageSource =
  'claude-jsonl' | 'claude-otel' | 'codex-rollout' | 'gemini-chat' | 'gemini-otel' | 'output-parser';

/** A normalized usage record (docs/plan/08-usage-monitor.md §4) as produced by collectors. */
export interface UsageRecord {
  /** Deduplication key, e.g. "claude:msg_…:req_…". */
  id: string;
  ts: number;
  agent: string;
  provider: string;
  rawModel: string;
  sessionId?: string;
  cwd?: string;
  isSubagent?: boolean;
  tokens: UsageTokens;
  extras?: UsageExtras;
  /** Cost reported by the source (older Claude `costUSD`, OTLP), when present. */
  reportedCostUsd?: number | null;
  source: UsageSource;
}

export const emptyTokens = (): UsageTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});
