import type { CodeMapGraph } from '@shared/domain/code-map';
import type { Learning } from '@shared/domain/code-map-memory';
import type { CodeMapSliceData, CodeMapSliceQuery } from '@shared/domain/code-map-plugin';
import type { ContextReceipt } from './receipts';
import { contextLearning, contextNode } from './context';

/** Read-only knowledge edges never become structural imports/calls. */
export function knowledgeSlice(
  graph: CodeMapGraph | undefined,
  records: Learning[],
  checkoutId: string,
  query: CodeMapSliceQuery,
  memoryRevision: number,
  receipt?: ContextReceipt,
): { data: CodeMapSliceData; reasons: ('NODE_LIMIT' | 'EDGE_LIMIT')[] } {
  const data: CodeMapSliceData = {
    kind: 'slice',
    view: query.view,
    memoryRevision,
    ...(receipt ? { receipt: receipt.id, receiptExpiresAt: new Date(receipt.expiresAt).toISOString() } : {}),
    nodes: [],
    edges: [],
    visitedNodes: 0,
    visitedEdges: 0,
    exhaustive: false,
  };
  const reasons = new Set<'NODE_LIMIT' | 'EDGE_LIMIT'>();
  const ids = new Set<string>();
  const files = new Map(graph?.files.map((f) => [f.path, f]));
  const add = (nodes: CodeMapSliceData['nodes'], edges: CodeMapSliceData['edges']) => {
    const fresh = [...new Map(nodes.filter((n) => !ids.has(n.id)).map((n) => [n.id, n])).values()];
    data.visitedNodes += fresh.length;
    data.visitedEdges += edges.length;
    if (data.nodes.length + fresh.length > query.maxNodes) {
      reasons.add('NODE_LIMIT');
      return;
    }
    if (data.edges.length + edges.length > query.maxEdges) {
      reasons.add('EDGE_LIMIT');
      return;
    }
    for (const node of fresh) {
      ids.add(node.id);
      data.nodes.push(node);
    }
    data.edges.push(...edges);
  };
  if (receipt && graph) {
    for (const item of receipt.nodes) {
      const node = contextNode(graph, item.id, item.whyIncluded);
      if (node) add([node], []);
    }
    for (const edge of receipt.relations) if (ids.has(edge.from) && ids.has(edge.to)) add([], [edge]);
  }
  const filter = query.learningState ?? 'active';
  const selected = receipt
    ? records.filter((r) => receipt.learnings.some((l) => l.id === r.id && l.revision === r.revision))
    : records.filter((r) => {
        if (
          query.pathPrefix &&
          !r.evidence.some((e) => e.path === query.pathPrefix || e.path.startsWith(`${query.pathPrefix}/`))
        )
          return false;
        if (filter === 'all') return true;
        if (filter === 'pending') return r.review === 'proposed';
        if (filter === 'stale') return r.applicability[checkoutId]?.state === 'needs-review';
        return (
          r.review === 'accepted' && r.admission !== 'automatic' && r.applicability[checkoutId]?.state === 'current'
        );
      });
  for (const record of selected) {
    const state = record.applicability[checkoutId] ?? {
      state: 'needs-review' as const,
      checkedAt: record.updatedAt,
      reason: 'Awaiting user review',
    };
    const why =
      receipt?.learnings.find((l) => l.id === record.id)?.whyIncluded ?? 'finding in the selected inspection scope';
    const reference = contextLearning({ ...record, applicability: { [checkoutId]: state } }, checkoutId, why);
    const learningId = `l:${record.id}`;
    const nodes: CodeMapSliceData['nodes'] = [
      {
        id: learningId,
        kind: 'learning',
        label: record.title,
        learning: reference,
        stale: state.state !== 'current' || record.review !== 'accepted' || record.admission === 'automatic',
        whyIncluded: why,
      },
    ];
    const edges: CodeMapSliceData['edges'] = [];
    for (const [i, evidence] of record.evidence.entries()) {
      const evidenceId = `e:${record.id}:${i}`;
      const file = files.get(evidence.path);
      nodes.push({
        id: evidenceId,
        kind: 'evidence',
        label: evidence.path,
        path: evidence.path,
        evidence: { path: evidence.path, hash: evidence.hash },
        sha256: file?.sha256,
        stale: state.state !== 'current',
        whyIncluded: 'whole-file evidence recorded with the claim',
      });
      edges.push({
        from: learningId,
        to: evidenceId,
        rel: 'supported_by',
        prov: 'knowledge',
        whyIncluded: 'reference evidence, not independent semantic verification',
      });
      const anchor = graph && contextNode(graph, evidence.symbolId ?? `f:${evidence.path}`, 'recorded evidence anchor');
      if (anchor && (!receipt || receipt.nodes.some((n) => n.id === anchor.id))) {
        nodes.push(anchor);
        edges.push({
          from: learningId,
          to: anchor.id,
          rel: 'applies_to',
          prov: 'knowledge',
          whyIncluded: 'claim scope anchor; not a structural dependency',
        });
      }
    }
    add(nodes, edges);
  }
  if (!receipt)
    for (const record of selected) {
      const from = `l:${record.id}`;
      for (const [target, rel] of [
        ...record.conflicts.map((id) => [id, 'conflicts_with'] as const),
        ...(record.replaces ? [[record.replaces, 'supersedes'] as const] : []),
      ])
        if (ids.has(from) && ids.has(`l:${target}`))
          add(
            [],
            [
              {
                from,
                to: `l:${target}`,
                rel,
                prov: 'knowledge',
                whyIncluded: 'explicit learning lifecycle relationship',
              },
            ],
          );
    }
  return { data, reasons: [...reasons] };
}
