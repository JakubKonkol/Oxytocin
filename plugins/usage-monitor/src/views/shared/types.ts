import type { SidebarDisplay } from '../../shared/sidebar-display';

/** View-side copies of the backend models (views cannot import backend code). */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface Totals {
  costUsd: number;
  unknownCostEvents: number;
  tokens: TokenTotals;
  events: number;
  sessions: number;
}

/** Code Map tool use of one agent session (counts only). */
export interface CodeMapFigure {
  calls: number;
  chars: number;
  stale: number;
  notOk: number;
  errors: number;
}

export interface LiveSession {
  sessionId: string;
  agent: string;
  model: string | null;
  projectId: string | null;
  projectName?: string;
  terminalId: string | null;
  state: string | null;
  costUsd: number;
  unknownCost: boolean;
  tokens: number;
  startedAt: number;
  lastEventAt: number;
  approximate: boolean;
}

export interface LimitBar {
  kind: string;
  label: string;
  ratio: number;
  resetsAt: number | null;
  exhaustedAt?: number | null;
  window?: string;
  observedAt?: number;
}

export interface SidebarModel {
  claudeStatusLine?: StatusLineStatus | null;
  /** Added by the backend from the settings (absent: everything is shown). */
  display?: SidebarDisplay;
  now: number;
  hasData: boolean;
  today: { costUsd: number; tokens: number; unknownCost: boolean; approximate: boolean };
  burnRate: { usdPerHour: number; trend: 'up' | 'down' | 'flat' };
  limit: LimitBar | null;
  limits: LimitBar[];
  subscriptionLimits: LimitBar[];
  /** Plan limits per account ("Claude (main)", "Codex (Work)"). */
  accountLimits: { agent: string; account: string; label: string; bars: LimitBar[] }[];
  sessions: LiveSession[];
  project: { id: string; name?: string; todayUsd: number; last7DaysUsd: number } | null;
  /** Every agent in use is billed by subscription: costs are hidden. */
  subscriptionOnly: boolean;
}

export interface SourceStatus {
  collectors: {
    source: 'claude-jsonl' | 'codex-rollout' | 'gemini-chat';
    enabled: boolean;
    roots: { path: string; exists: boolean }[];
    files: number;
    lastEventAt: number | null;
    parseErrors: number;
  }[];
  otlp: { port: number | null; packets: number; rejected: number; lastPacketAt: number | null } | null;
  userOtelConfig: string | null;
}

export interface Progress {
  source: string;
  done: number;
  total: number;
}

export interface StatusLineStatus {
  enabled: boolean;
  installed: boolean;
  settingsFile: string;
  observedAt: number | null;
  error: string | null;
}
