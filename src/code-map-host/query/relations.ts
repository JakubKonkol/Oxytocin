import type { CodeMapEdge, CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapQuery, CodeMapQueryData } from '@shared/domain/code-map-query';

type Data = Extract<CodeMapQueryData, { kind: 'relations' }>;
type Request = Extract<CodeMapQuery, { kind: 'relations' }>;
/** Adjacency and node lookup are built once per generation, never in main. */
export class CodeRelations {
  private readonly nodes = new Map<string, Data['nodes'][number]>();
  private readonly incoming = new Map<string, CodeMapEdge[]>();
  private readonly outgoing = new Map<string, CodeMapEdge[]>();
  private fileIncoming?: Map<string, CodeMapEdge[]>;
  constructor(private readonly graph: CodeMapGraph) {
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
  private fileDependencies(): Map<string, CodeMapEdge[]> {
    if (this.fileIncoming) return this.fileIncoming;
    const incoming = new Map<string, CodeMapEdge[]>();
    for (const edge of this.graph.edges) {
      const from = this.fileId(edge.from),
        to = this.fileId(edge.to);
      if (from && to && from !== to && edge.rel !== 'contains') {
        const projected = incoming.get(to) ?? [];
        projected.push(edge);
        incoming.set(to, projected);
      }
    }
    return (this.fileIncoming = incoming);
  }
  private fileId(id: string): string | undefined {
    const node = this.nodes.get(id);
    return node?.kind === 'file' ? node.value.id : node?.kind === 'symbol' ? node.value.file : undefined;
  }
  /** File membership is projected without consuming a dependency hop. Deleted/unindexed roots stay absent. */
  dependents(
    paths: string[],
    request: Pick<Request, 'depth' | 'relations' | 'includeHeuristic'>,
  ): { data: Data; truncated: boolean } {
    const incoming = this.fileDependencies();
    const nodes: Data['nodes'] = [],
      edges: Data['edges'] = [];
    const queue: { id: string; depth: number }[] = [],
      seen = new Set<string>(),
      seenEdges = new Set<CodeMapEdge>();
    for (const path of [...new Set(paths)].sort()) {
      const id = `f:${path}`,
        node = this.nodes.get(id);
      if (!node || node.kind !== 'file') continue;
      seen.add(id);
      nodes.push({ ...node, whyIncluded: 'requested changed file' });
      queue.push({ id, depth: 0 });
    }
    let visitedEdges = 0,
      truncated = false;
    outer: for (let offset = 0; offset < queue.length; offset++) {
      const current = queue[offset]!;
      if (current.depth === request.depth) continue;
      for (const edge of incoming.get(current.id) ?? []) {
        if (seenEdges.has(edge)) continue;
        if (visitedEdges === 5000) {
          truncated = true;
          break outer;
        }
        seenEdges.add(edge);
        visitedEdges++;
        if (!request.relations.includes(edge.rel) || (!request.includeHeuristic && edge.prov === 'heuristic')) continue;
        const from = this.fileId(edge.from)!;
        if (!seen.has(from)) {
          if (seen.size === 2000) {
            truncated = true;
            break outer;
          }
          seen.add(from);
          nodes.push({ ...this.nodes.get(from)!, whyIncluded: `${edge.rel} to ${current.id}`.slice(0, 200) });
          queue.push({ id: from, depth: current.depth + 1 });
        }
        edges.push({
          ...edge,
          from,
          to: current.id,
          whyIncluded: `${edge.prov} file dependency at depth ${current.depth + 1}`,
        });
      }
    }
    return {
      data: { kind: 'relations', nodes, edges, visitedNodes: seen.size, visitedEdges, exhaustive: false },
      truncated,
    };
  }
  /** The innermost symbol of `path` whose span contains `line`; a symbol starting on that line wins. */
  private symbolAt(path: string, line: number): string | undefined {
    const fileId = `f:${path}`;
    let best: CodeMapGraph['symbols'][number] | undefined;
    const rank = (s: CodeMapGraph['symbols'][number]) => [s.span[0] === line ? 0 : 1, s.span[2] - s.span[0]] as const;
    for (const symbol of this.graph.symbols) {
      if (symbol.file !== fileId || line < symbol.span[0] || line > symbol.span[2]) continue;
      if (!best) best = symbol;
      else {
        const [a, b] = [rank(symbol), rank(best)];
        if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = symbol;
      }
    }
    return best?.id;
  }
  query(request: Request): { data: Data | null; truncated: boolean } {
    const symbolId = request.symbolId ?? (request.line ? this.symbolAt(request.path!, request.line) : undefined);
    if (request.line && !symbolId) return { data: null, truncated: false };
    const root = symbolId ?? `f:${request.path!}`;
    const first = this.nodes.get(root);
    if (!first || (symbolId && first.kind !== 'symbol')) return { data: null, truncated: false };
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
