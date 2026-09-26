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
  /** Gemini CLI: sha256 of the project root (sessions carry no cwd). */
  projectHash?: string;
  /** When the agent session started (Codex `session_meta`, Gemini `startTime`) — terminal correlation. */
  sessionStartedAt?: number;
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

/** A rate limit reported by an agent (Codex `rate_limits`) → `agent_limits` (§7, §13). */
export interface AgentLimitRecord {
  kind: 'limit';
  agent: string;
  window: string;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
  observedAt: number;
}

export type CollectedItem = UsageRecord | AgentLimitRecord;

export const isLimit = (item: CollectedItem): item is AgentLimitRecord => 'kind' in item && item.kind === 'limit';
