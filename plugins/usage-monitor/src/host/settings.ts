import type { CostMode } from './pricing/types';

export interface UsageSettings {
  costMode: CostMode;
  pricingAutoUpdate: boolean;
  pricingOverrides: unknown;
}

export const DEFAULT_SETTINGS: UsageSettings = { costMode: 'auto', pricingAutoUpdate: true, pricingOverrides: {} };
