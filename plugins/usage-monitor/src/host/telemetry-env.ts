import type { EnvironmentCollection, EnvScope } from '@oxytocin/plugin-api';
import type { TelemetrySettings } from './settings';

export interface OtlpEndpointInfo {
  port: number;
  token: string;
}

/** Profiles of the built-in agent launchers (core `shell-detect/agents.ts`). */
export const CLAUDE_PROFILES = ['agent:claude'];
export const GEMINI_PROFILES = ['agent:gemini'];

/**
 * Variables that point Claude Code / Gemini CLI at the local receiver (docs/plan/08-usage-monitor.md §9.3). Resource
 * attributes are appended (comma separator) so a user's own `OTEL_RESOURCE_ATTRIBUTES` survives. Claude Code
 * variables are skipped when the user configured OpenTelemetry themselves.
 */
export function applyTelemetryEnv(
  env: EnvironmentCollection,
  endpoint: OtlpEndpointInfo | null,
  settings: TelemetrySettings,
  userConfig: string | null,
): void {
  env.clear();
  env.description = 'Usage Monitor live telemetry';
  if (endpoint) {
    const url = `http://127.0.0.1:${endpoint.port}`;
    const scoped = (profiles: string[]): EnvScope | undefined =>
      settings.scope === 'allTerminals' ? undefined : { profileIds: profiles };
    if (settings.claudeCode && !userConfig) {
      const scope = scoped(CLAUDE_PROFILES);
      const vars: Record<string, string> = {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${endpoint.token}`,
        OTEL_METRIC_EXPORT_INTERVAL: '5000',
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
      };
      for (const [name, value] of Object.entries(vars)) env.replace(name, value, scope);
      env.append(
        'OTEL_RESOURCE_ATTRIBUTES',
        'oxytocin.source=oxytocin,oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID},oxytocin.project_id=${env:OXYTOCIN_PROJECT_ID}',
        scope,
        { separator: ',' },
      );
    }
    if (settings.gemini) {
      const scope = scoped(GEMINI_PROFILES);
      const vars: Record<string, string> = {
        GEMINI_TELEMETRY_ENABLED: 'true',
        GEMINI_TELEMETRY_TARGET: 'local',
        GEMINI_TELEMETRY_OTLP_ENDPOINT: url,
        GEMINI_TELEMETRY_OTLP_PROTOCOL: 'http',
      };
      for (const [name, value] of Object.entries(vars)) env.replace(name, value, scope);
    }
  }
  env.ready();
}
