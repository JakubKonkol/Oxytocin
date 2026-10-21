import type { CodeMapQueryResult } from '@shared/domain/code-map-query';
import type { CodeMapFreshness } from '@shared/domain/code-map-plugin';
import type { TaskContextResult } from '@shared/domain/code-map-learning-tools';

// MCP is a reading surface. The plugin/IPC schemas retain their complete inspection data.
// JSON-quote source strings so a declaration cannot inject extra result rows.
const q = (text: string) => JSON.stringify(text);
const location = (path: string, span?: readonly number[]) => `${q(path)}${span ? `:${span[0]}-${span[2]}` : ''}`;
function header(checkout: string, f: CodeMapFreshness): string[] {
  const { indexed, unsupported, failed, skipped } = f.coverage.files;
  return [
    `checkout=${q(checkout)} generation=${f.generation} ${f.state} stale=${f.stale} verification=${f.verification} pending=${f.pendingFiles}`,
    `coverage: ${indexed} indexed, ${unsupported} file-only, ${failed} failed, ${skipped} skipped; unresolved: ${f.coverage.unresolved.imports} imports, ${f.coverage.unresolved.calls} calls. Partial index.`,
    ...f.warnings.map((w) => `warning: ${q(w)}`),
  ];
}
function finish(lines: string[], original: unknown): string {
  const compact = lines.join('\n'),
    json = JSON.stringify(original);
  // Never exceed the already enforced complete response budget, including escaping.
  return compact.length <= json.length ? compact : json;
}
export function formatCodeMap(result: CodeMapQueryResult): string {
  if (!result.freshness || result.data?.kind === 'status') return JSON.stringify(result);
  const lines = [`${result.code}`, ...header(result.checkoutId, result.freshness)];
  const data = result.data;
  if (data?.kind === 'search') {
    for (const m of data.matches) {
      lines.push(`${location(m.path, m.span)} ${m.kind} ${q(m.signature ?? m.name)}${m.stale ? ' STALE' : ''}`);
      if (m.kind !== 'file') lines.push(`  symbolId=${q(m.id)}`);
    }
    if (!data.matches.length) lines.push('No indexed matches. Use text search.');
  } else if (data?.kind === 'outline') {
    lines.push(`${q(data.file.path)} status=${data.file.status}${data.file.stale ? ' STALE' : ''}`);
    for (const s of data.definitions)
      lines.push(`${s.span[0]}-${s.span[2]} ${q(s.signature)} id=${q(s.id)}${s.stale ? ' STALE' : ''}`);
    for (const e of data.imports) lines.push(`imports ${q(e.to)} [${e.prov}${e.typeOnly ? ', type-only' : ''}]`);
  } else if (data?.kind === 'relations') {
    const ids = new Map(data.nodes.map((n, i) => [n.value.id, i + 1]));
    for (const n of data.nodes) {
      const v = n.value;
      lines.push(
        `${ids.get(v.id)} ${n.kind} id=${q(v.id)}${'signature' in v ? ` ${q(v.signature)}` : ''}${'span' in v ? ` lines=${v.span[0]}-${v.span[2]}` : ''}${'stale' in v && v.stale ? ' STALE' : ''}`,
      );
    }
    for (const e of data.edges)
      lines.push(
        `${ids.get(e.from)} -> ${ids.get(e.to)} ${e.rel} [${e.prov}${e.typeOnly ? ', type-only' : ''}]${e.at ? ` at ${e.at.join(':')}` : ''}`,
      );
    lines.push(`Visited ${data.visitedNodes} nodes / ${data.visitedEdges} edges; not exhaustive.`);
  } else if (data?.kind === 'repo-map') lines.push(data.markdown);
  if (result.truncated) lines.push(`Truncated: ${result.reasons.join(', ')}. Narrow the query or increase maxChars.`);
  if (result.code !== 'OK') lines.push(result.hint);
  return finish(lines, result);
}

export function formatTaskContext(result: TaskContextResult): string {
  const lines = [
    'OK task-context',
    ...header(result.checkoutId, result.freshness),
    `memory=${result.memory} revision=${result.memoryRevision}`,
  ];
  const ids = new Map(result.nodes.map((n, i) => [n.id, i + 1]));
  for (const n of result.nodes) {
    lines.push(
      `${ids.get(n.id)} ${location(n.path ?? n.label, n.span)} ${n.symbolKind ?? n.kind} ${q(n.signature ?? n.label)}${n.stale ? ' STALE' : ''}`,
    );
    if (n.kind === 'symbol') lines.push(`  symbolId=${q(n.id)}`);
  }
  for (const e of result.relations) lines.push(`${ids.get(e.from)} -> ${ids.get(e.to)} ${e.rel} [${e.prov}]`);
  // Preserve the exact admitted claim, provenance and evidence; the receipt covers these exact revisions.
  for (const learning of result.learnings) lines.push(`learning: ${JSON.stringify(learning)}`);
  if (result.receipt) lines.push(`receipt=${q(result.receipt)}`);
  if (!result.nodes.length && !result.learnings.length) lines.push('No relevant context. Use text search.');
  if (result.truncated)
    lines.push(`Omitted: ${JSON.stringify(result.omitted)}. Narrow the question/anchors or increase limit/maxChars.`);
  lines.push(...result.warnings.map((w) => `warning: ${q(w)}`));
  return finish(lines, result);
}
