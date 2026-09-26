/** OTLP/JSON payloads for tests (not part of the plugin bundle). */
export const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
});
export const point = (attrs: Record<string, string>, value: number, t = '1790445600000000000') => ({
  attributes: Object.entries(attrs).map(([k, v]) => kv(k, v)),
  startTimeUnixNano: '1790445000000000000',
  timeUnixNano: t,
  asDouble: value,
});
export function claudeExport(session: string, terminal: string | null, tokens: Record<string, number>, cost: number) {
  const base = { model: 'claude-opus-5-5', 'session.id': session };
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            kv('service.name', 'claude-code'),
            ...(terminal ? [kv('oxytocin.terminal_id', terminal), kv('oxytocin.project_id', 'p1')] : []),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: Object.entries(tokens).map(([type, v]) => point({ ...base, type }, v)),
                },
              },
              { name: 'claude_code.cost.usage', sum: { aggregationTemporality: 1, dataPoints: [point(base, cost)] } },
              { name: 'claude_code.session.count', sum: { dataPoints: [point(base, 1)] } },
            ],
          },
        ],
      },
    ],
  };
}
