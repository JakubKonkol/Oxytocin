import type { CostMode } from './pricing/types';

export interface UsageSettings {
  costMode: CostMode;
  pricingAutoUpdate: boolean;
  pricingOverrides: unknown;
}

export const DEFAULT_SETTINGS: UsageSettings = { costMode: 'auto', pricingAutoUpdate: true, pricingOverrides: {} };

/** Collector options (read once at start; changing them restarts the collectors). */
export interface CollectorSettings {
  claudeCode: boolean;
  claudeExtraDirs: string[];
  codex: boolean;
  gemini: boolean;
  backfillDays: number;
}
