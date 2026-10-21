import { CodeMapQueryResultSchema, type CodeMapQueryResult } from '@shared/domain/code-map-query';

/** Budget the complete serialized envelope, including metadata and JSON escaping. Never slice JSON text. */
export function boundResult(input: CodeMapQueryResult, maxChars: number): CodeMapQueryResult {
  const result = structuredClone(input);
  const size = () => JSON.stringify(result).length;
  if (size() <= maxChars) return CodeMapQueryResultSchema.parse(result);
  result.truncated = true;
  if (!result.reasons.includes('CHAR_BUDGET')) result.reasons.push('CHAR_BUDGET');
  result.hint = 'Narrow pathPrefix or the query; increase maxChars for more detail.';
  while (size() > maxChars && result.data) {
    const data = result.data;
    if (data.kind === 'search' && data.matches.length) data.matches.length = Math.floor(data.matches.length * 0.8);
    else if (data.kind === 'outline' && data.definitions.length)
      data.definitions.length = Math.floor(data.definitions.length * 0.8);
    else if (data.kind === 'outline' && data.imports.length)
      data.imports.length = Math.floor(data.imports.length * 0.8);
    else if (data.kind === 'relations' && data.nodes.length > 1) {
      // Keep a useful connected prefix instead of spending the budget on orphan nodes.
      const removed = data.nodes.pop()!;
      data.edges = data.edges.filter((edge) => edge.from !== removed.value.id && edge.to !== removed.value.id);
    } else if (data.kind === 'relations' && data.edges.length) data.edges.pop();
    else if (data.kind === 'repo-map' && data.markdown.length > 100)
      data.markdown = data.markdown.slice(0, Math.floor(data.markdown.length * 0.8));
    else {
      delete result.data;
      result.code = 'BUDGET';
    }
  }
  if (result.data?.kind === 'relations') {
    const ids = new Set(result.data.nodes.map((n) => n.value.id));
    result.data.edges = result.data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }
  if (size() > maxChars) {
    result.freshness.warnings = [];
    result.freshness.coverage = { ...result.freshness.coverage, byLanguage: {} };
    result.code = 'BUDGET';
  }
  if (size() > maxChars) throw new Error('Code Map response metadata exceeds the character budget');
  return CodeMapQueryResultSchema.parse(result);
}
