import type { CodeMapEdge, CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapQuery, CodeMapQueryData } from '@shared/domain/code-map-query';

type Data = Extract<CodeMapQueryData, { kind: 'relations' }>;
type Request = Extract<CodeMapQuery, { kind: 'relations' }>;
/** Adjacency and node lookup are built once per generation, never in main. */
export class CodeRelations {
  private readonly nodes = new Map<string, Data['nodes'][number]>();
  private readonly incoming = new Map<string, CodeMapEdge[]>();
  private readonly outgoing = new Map<string, CodeMapEdge[]>();
  constructor(graph: CodeMapGraph) {
    for (const value of graph.files) this.nodes.set(value.id, { kind: 'file', value, whyIncluded: '' });
    for (const value of graph.symbols) this.nodes.set(value.id, { kind: 'symbol', value, whyIncluded: '' });
    for (const value of graph.groups) this.nodes.set(value.id, { kind: 'group', value, whyIncluded: '' });
    for (const value of graph.packages) this.nodes.set(value.id, { kind: 'package', value, whyIncluded: '' });
    for (const edge of graph.edges) {
      const incoming = this.incoming.get(edge.to) ?? [],
        outgoing = this.outgoing.get(edge.from) ?? [];
      incoming.push(edge);
      outgoing.push(edge);
      this.incoming.set(edge.to, incoming);
      this.outgoing.set(edge.from, outgoing);
    }
  }
  query(request: Request): { data: Data | null; truncated: boolean } {
    const root = request.symbolId ?? `f:${request.path!}`;
    const first = this.nodes.get(root);
    if (!first || (request.symbolId && first.kind !== 'symbol')) return { data: null, truncated: false };
    const nodes: Data['nodes'] = [{ ...first, whyIncluded: 'requested root' }];
    const edges: Data['edges'] = [];
    const seenNodes = new Set([root]),
      seenEdges = new Set<CodeMapEdge>();
    const queue = [{ id: root, depth: 0 }];
    let visitedEdges = 0,
      truncated = false;
    outer: for (let offset = 0; offset < queue.length; offset++) {
      const current = queue[offset]!;
      if (current.depth === request.depth) continue;
      const candidates = [
        ...(request.direction !== 'outgoing' ? (this.incoming.get(current.id) ?? []) : []),
        ...(request.direction !== 'incoming' ? (this.outgoing.get(current.id) ?? []) : []),
      ];
      for (const edge of candidates) {
        if (seenEdges.has(edge)) continue;
        if (visitedEdges === 5000) {
          truncated = true;
          break outer;
        }
        seenEdges.add(edge);
        visitedEdges++;
        if (!request.relations.includes(edge.rel) || (!request.includeHeuristic && edge.prov === 'heuristic')) continue;
        const neighbor = edge.from === current.id ? edge.to : edge.from;
        const node = this.nodes.get(neighbor);
        if (!node) continue;
        if (!seenNodes.has(neighbor)) {
          if (seenNodes.size === 2000) {
            truncated = true;
            break outer;
          }
          seenNodes.add(neighbor);
          nodes.push({
            ...node,
            whyIncluded: `${edge.rel} ${edge.from === current.id ? 'from' : 'to'} ${current.id}`.slice(0, 200),
          });
          queue.push({ id: neighbor, depth: current.depth + 1 });
        }
        edges.push({ ...edge, whyIncluded: `${edge.prov} evidence at depth ${current.depth + 1}` });
      }
    }
    return {
      data: { kind: 'relations', nodes, edges, visitedNodes: seenNodes.size, visitedEdges, exhaustive: false },
      truncated,
    };
  }
}
