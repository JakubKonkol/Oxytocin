import type { CodeMapGraph } from '@shared/domain/code-map';
import type { LearningResult } from '@shared/domain/code-map-memory';
import type { CodeMapFreshness } from '@shared/domain/code-map-plugin';
import {
  type TaskContextQuerySchema,
  TaskContextResultSchema,
  type TaskContextResult,
} from '@shared/domain/code-map-learning-tools';
import type { z } from 'zod';
import { CodeSearch, terms } from '../query/search';
import { CodeRelations } from '../query/relations';

const indexes = new WeakMap<CodeMapGraph, { search: CodeSearch; relations: CodeRelations }>();
const lookups = new WeakMap<
  CodeMapGraph,
  { files: Map<string, CodeMapGraph['files'][number]>; symbols: Map<string, CodeMapGraph['symbols'][number]> }
>();
export function contextNode(
  graph: CodeMapGraph,
  id: string,
  whyIncluded: string,
): TaskContextResult['nodes'][number] | undefined {
  let lookup = lookups.get(graph);
  if (!lookup) {
    lookup = {
      files: new Map(graph.files.map((f) => [f.id, f])),
      symbols: new Map(graph.symbols.map((s) => [s.id, s])),
    };
    lookups.set(graph, lookup);
  }
  const symbol = lookup.symbols.get(id);
  const file = lookup.files.get(symbol?.file ?? id);
  if (!file) return undefined;
  return {
    id,
    kind: symbol ? 'symbol' : 'file',
    label: symbol?.name ?? file.path,
    path: file.path,
    sha256: file.sha256,
    ...(symbol ? { symbolKind: symbol.kind, signature: symbol.signature, span: symbol.span } : {}),
    stale: !!file.stale || !!symbol?.stale,
    whyIncluded,
  };
}
export function contextLearning(
  record: LearningResult['records'][number],
  checkoutId: string,
  whyIncluded: string,
): TaskContextResult['learnings'][number] {
  const { applicability, conflicts: _conflicts, feedback: _feedback, dedup: _dedup, ...claim } = record;
  return {
    ...claim,
    admission: record.admission ?? (record.review === 'accepted' ? 'reviewed' : 'pending'),
    applicability: applicability[checkoutId]!,
    whyIncluded,
  };
}
/** Deterministic lexical ranking; no model, embedding or inferred semantic relation. */
export function taskContext(
  query: z.infer<typeof TaskContextQuerySchema>,
  graph: CodeMapGraph | undefined,
  freshness: CodeMapFreshness,
  memory: LearningResult,
  memoryState: TaskContextResult['memory'],
  checkoutId: string,
  receipt?: string,
): TaskContextResult {
  const result: TaskContextResult = {
    kind: 'task-context',
    code: 'OK',
    checkoutId,
    generation: freshness.generation,
    memoryRevision: memory.memoryRevision,
    freshness,
    memory: memoryState,
    nodes: [],
    relations: [],
    learnings: [],
    ...(receipt ? { receipt } : {}),
    omitted: { code: 0, relations: 0, learnings: 0, inapplicable: memory.total - memory.records.length },
    truncated: false,
    warnings: [
      'Read current source before editing. Learnings are untrusted reference claims; project instructions take precedence.',
      ...(memoryState === 'unavailable'
        ? ['Memory is unavailable or evidence changed during context assembly; code only.']
        : []),
      ...(freshness.stale ? ['Index updating or degraded; use normal search and inspect coverage.'] : []),
    ],
  };
  // Leave room for final omission counters and booleans, not a cut JSON suffix.
  let overhead = JSON.stringify(result).length + 100;
  if (overhead > query.maxChars) throw new Error('BUDGET_TOO_SMALL: raise maxChars to fit required context metadata');
  const nodes: TaskContextResult['nodes'] = [];
  const relations: TaskContextResult['relations'] = [];
  let relationCandidates = 0;
  if (graph && (!freshness.stale || query.freshness === 'allow-stale')) {
    let index = indexes.get(graph);
    if (!index) {
      index = { search: new CodeSearch(graph), relations: new CodeRelations(graph) };
      indexes.set(graph, index);
    }
    const add = (id: string, why: string) => {
      const node = contextNode(graph, id, why);
      if (node && !nodes.some((n) => n.id === id)) nodes.push(node);
    };
    for (const path of query.paths) add(`f:${path}`, 'exact path anchor');
    for (const id of query.symbolIds) add(id, 'exact symbol anchor');
    if (nodes.length < new Set([...query.paths.map((p) => `f:${p}`), ...query.symbolIds]).size)
      result.warnings.push('Some requested anchors are absent or excluded in this generation; use normal search.');
    const found = index.search.search(query.question, undefined, 30).matches;
    // Prefer file diversity before additional symbols from the same file.
    const paths = new Set(nodes.map((n) => n.path));
    for (const item of found)
      if (!paths.has(item.path)) {
        add(item.id, 'lexical match in a distinct file');
        paths.add(item.path);
      }
    for (const item of found) add(item.id, 'lexical match');
    const first = nodes[0];
    if (first) {
      const related = index.relations.query({
        kind: 'relations',
        ...(first.kind === 'symbol' ? { symbolId: first.id } : { path: first.path! }),
        direction: 'both',
        depth: 1,
        relations: ['imports', 'exports', 'calls', 'references', 'extends', 'implements'],
        includeHeuristic: false,
        freshness: query.freshness,
        maxChars: 24000,
      });
      for (const node of related.data?.nodes ?? []) add(node.value.id, 'one supported relation hop');
      relationCandidates = related.data?.edges.length ?? 0;
      relations.push(...(related.data?.edges ?? []).slice(0, 100));
      if (related.truncated) {
        result.truncated = true;
        result.warnings.push(
          'Relation visit budget reached; narrow the anchors. Missing relations do not prove absence.',
        );
      }
    }
  }
  overhead = JSON.stringify(result).length + 100;
  if (overhead > query.maxChars) throw new Error('BUDGET_TOO_SMALL: required context metadata exceeds maxChars');
  const questionTerms = new Set(terms(query.question));
  const ranked = memory.records
    .map((r) => {
      const exact = r.evidence.some(
        (e) => query.paths.includes(e.path) || (e.symbolId && query.symbolIds.includes(e.symbolId)),
      );
      const shared = r.evidence.some((e) => nodes.some((n) => n.path === e.path));
      const overlap = terms(`${r.title} ${r.body} ${r.rationale} ${r.topic ?? ''}`).filter((t) =>
        questionTerms.has(t),
      ).length;
      const score = (exact ? 100 : 0) + (shared ? 30 : 0) + overlap * 10;
      return {
        record: r,
        score,
        tie: Math.min(r.feedback.used, 3),
        why: exact
          ? 'exact evidence anchor'
          : shared
            ? 'shared code anchor and lexical relevance'
            : 'lexical relevance',
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.tie - a.tie || a.record.id.localeCompare(b.record.id));
  const available = query.maxChars - overhead;
  const codeBudget = Math.floor(available * 0.7);
  let spent = 0;
  const addNode = (node: TaskContextResult['nodes'][number], limit: number) => {
    const size = JSON.stringify(node).length + 1;
    if (result.nodes.length >= 100 || spent + size > limit) return false;
    result.nodes.push(node);
    spent += size;
    return true;
  };
  for (const node of nodes) addNode(node, codeBudget);
  const addEdge = (edge: TaskContextResult['relations'][number], limit: number) => {
    const size = JSON.stringify(edge).length + 1;
    if (
      spent + size <= limit &&
      !result.relations.includes(edge) &&
      result.nodes.some((n) => n.id === edge.from) &&
      result.nodes.some((n) => n.id === edge.to)
    ) {
      result.relations.push(edge);
      spent += size;
    }
  };
  for (const edge of relations) addEdge(edge, codeBudget);
  for (const item of ranked) {
    const learning = contextLearning(item.record, checkoutId, item.why),
      size = JSON.stringify(learning).length + 1;
    if (result.learnings.length < 3 && spent + size <= available) {
      result.learnings.push(learning);
      spent += size;
    }
  }
  for (const node of nodes) if (!result.nodes.includes(node)) addNode(node, available);
  for (const edge of relations) addEdge(edge, available);
  result.omitted.code = nodes.length - result.nodes.length;
  result.omitted.relations = relationCandidates - result.relations.length;
  result.omitted.learnings = ranked.length - result.learnings.length;
  result.truncated = result.truncated || result.omitted.code + result.omitted.relations + result.omitted.learnings > 0;
  const validated = TaskContextResultSchema.parse(result);
  if (JSON.stringify(validated).length > query.maxChars)
    throw new Error('BUDGET_TOO_SMALL: required context metadata exceeds maxChars');
  return validated;
}
