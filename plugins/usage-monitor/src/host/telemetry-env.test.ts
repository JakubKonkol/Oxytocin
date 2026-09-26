import { describe, expect, it } from 'vitest';
import type { EnvironmentCollection } from '@oxytocin/plugin-api';
import { applyTelemetryEnv } from './telemetry-env';

function collection() {
  const ops: unknown[][] = [];
  const env: EnvironmentCollection = {
    replace: (...a) => void ops.push(['replace', ...a]),
    append: (...a) => void ops.push(['append', ...a]),
    prepend: (...a) => void ops.push(['prepend', ...a]),
    delete: (...a) => void ops.push(['delete', ...a]),
    clear: () => void ops.push(['clear']),
    ready: () => void ops.push(['ready']),
  };
  return { env, ops };
}

describe('live telemetry environment', () => {
  const endpoint = { port: 43210, token: 'tok' };
  it('points agent profiles at the receiver and appends resource attributes', () => {
    const { env, ops } = collection();
    applyTelemetryEnv(env, endpoint, { claudeCode: true, gemini: true, scope: 'agentProfiles' }, null);
    expect(ops[0]).toEqual(['clear']);
    expect(ops).toContainEqual([
      'replace',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'http://127.0.0.1:43210',
      { profileIds: ['agent:claude'] },
    ]);
    expect(ops).toContainEqual([
      'replace',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'Authorization=Bearer tok',
      { profileIds: ['agent:claude'] },
    ]);
    expect(ops).toContainEqual([
      'append',
      'OTEL_RESOURCE_ATTRIBUTES',
      'oxytocin.source=oxytocin,oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID},oxytocin.project_id=${env:OXYTOCIN_PROJECT_ID}',
      { profileIds: ['agent:claude'] },
      { separator: ',' },
    ]);
    expect(ops).toContainEqual([
      'replace',
      'GEMINI_TELEMETRY_OTLP_ENDPOINT',
      'http://127.0.0.1:43210',
      { profileIds: ['agent:gemini'] },
    ]);
    expect(ops.at(-1)).toEqual(['ready']);
  });

  it('leaves Claude Code alone when the user configured OpenTelemetry, and clears everything when off', () => {
    const { env, ops } = collection();
    applyTelemetryEnv(
      env,
      endpoint,
      { claudeCode: true, gemini: false, scope: 'allTerminals' },
      'OTEL_METRICS_EXPORTER is set',
    );
    expect(ops).toEqual([['clear'], ['ready']]);
    const off = collection();
    applyTelemetryEnv(off.env, null, { claudeCode: false, gemini: false, scope: 'agentProfiles' }, null);
    expect(off.ops).toEqual([['clear'], ['ready']]);
  });
});
