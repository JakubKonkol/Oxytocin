import type { CostMode } from './pricing/types';

export type Billing = 'api' | 'subscription';

export interface UsageSettings {
  costMode: CostMode;
  pricingAutoUpdate: boolean;
  pricingOverrides: unknown;
  /** `usage.billing.*` per agent id (subscription → "API-equivalent", amounts prefixed with ≈). */
  billing: Record<string, Billing>;
  weekStartsOn: 'monday' | 'sunday';
  /** `usage.limits.claudeBlock`: own limit of a Claude 5-hour block. */
  claudeBlockLimit: { metric: 'tokens' | 'usd'; amount: number } | null;
  retentionDays: number;
}

export const DEFAULT_SETTINGS: UsageSettings = {
  costMode: 'auto',
  pricingAutoUpdate: true,
  pricingOverrides: {},
  billing: {},
  weekStartsOn: 'monday',
  claudeBlockLimit: null,
  retentionDays: 400,
};

/** Collector options (read once at start; changing them restarts the collectors). */
export interface CollectorSettings {
  claudeCode: boolean;
  claudeExtraDirs: string[];
  codex: boolean;
  gemini: boolean;
  backfillDays: number;
}

export interface TelemetrySettings {
  claudeCode: boolean;
  gemini: boolean;
  scope: 'agentProfiles' | 'allTerminals';
}
