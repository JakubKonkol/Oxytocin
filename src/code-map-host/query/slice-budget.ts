import { CodeMapHostQueryResultSchema, type CodeMapHostQueryResult } from '@shared/domain/code-map-plugin';

export function boundSliceResult(input: CodeMapHostQueryResult): CodeMapHostQueryResult {
  const result = structuredClone(input);
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) {
    result.truncated = true;
    result.reasons.push('BYTE_BUDGET');
    while (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024 && result.data?.kind === 'slice') {
      const data = result.data;
      if (data.nodes.length > 1) data.nodes.length = Math.max(1, Math.floor(data.nodes.length * 0.8));
      else {
        delete result.data;
        result.code = 'BUDGET';
        break;
      }
      const ids = new Set(data.nodes.map((node) => node.id));
      data.edges = data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) {
    delete result.data;
    result.code = 'BUDGET';
    result.freshness.coverage = { ...result.freshness.coverage, byLanguage: {} };
    result.freshness.warnings = [];
  }
  return CodeMapHostQueryResultSchema.parse(result);
}
