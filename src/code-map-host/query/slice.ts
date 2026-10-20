import type { CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapSliceData, CodeMapSliceQuery } from '@shared/domain/code-map-plugin';
import { CodeMapQuerySchema } from '@shared/domain/code-map-query';
import { CodeRelations } from './relations';
import { withinPrefix } from './search';
import { comparePaths } from '../enumerate';

export function graphSlice(
  graph: CodeMapGraph,
  request: CodeMapSliceQuery,
  neighbors?: CodeRelations,
): { data: CodeMapSliceData | null; reasons: ('NODE_LIMIT' | 'EDGE_LIMIT' | 'VISIT_LIMIT')[] } {
  const data: CodeMapSliceData = {
    kind: 'slice',
    view: request.view,
    nodes: [],
    edges: [],
    visitedNodes: 0,
    visitedEdges: 0,
    exhaustive: false,
  };
  const reasons: ('NODE_LIMIT' | 'EDGE_LIMIT' | 'VISIT_LIMIT')[] = [];
  if (request.view === 'overview') {
    const prefix = request.pathPrefix ?? (request.root && 'path' in request.root ? request.root.path : undefined);
    const scope = graph.files.filter((file) => withinPrefix(file.path, prefix));
    const byFile = new Map<string, string>();
    const groups = new Map<string, CodeMapSliceData['nodes'][number]>();
    for (const file of scope) {
      const rest = prefix
        ? file.path === prefix
          ? file.path.split('/').at(-1)!
          : file.path.slice(prefix.length + 1)
        : file.path;
      const segment = rest.split('/')[0]!;
      const folder = rest.includes('/') ? (prefix ? `${prefix}/${segment}` : segment) : undefined;
      const id = folder ? `d:${folder}` : file.id;
      byFile.set(file.id, id);
      const node =
        groups.get(id) ??
        (folder
          ? {
              id,
              kind: 'group' as const,
              label: segment,
              path: folder,
              files: 0,
              whyIncluded: 'folder in selected scope',
            }
          : {
              id,
              kind: 'file' as const,
              label: segment,
              path: file.path,
              sha256: file.sha256,
              stale: !!file.stale,
              whyIncluded: 'file in selected scope',
            });
      if (node.kind === 'group') node.files = (node.files ?? 0) + 1;
      groups.set(id, node);
    }
    const aggregated = new Map<string, CodeMapSliceData['edges'][number]>();
    // Aggregation counts the immutable base graph, not just the visible limited subset.
    for (const edge of graph.edges) {
      if (
        !['imports', 'references'].includes(edge.rel) ||
        !request.relations.includes(edge.rel) ||
        (!request.includeHeuristic && edge.prov === 'heuristic')
      )
        continue;
      const from = byFile.get(edge.from),
        to = byFile.get(edge.to);
      if (!from || !to || from === to) continue;
      const key = JSON.stringify([from, to, edge.rel, edge.prov, edge.typeOnly]);
      const value = aggregated.get(key) ?? {
        from,
        to,
        rel: edge.rel,
        prov: edge.prov,
        count: 0,
        ...(edge.typeOnly === undefined ? {} : { typeOnly: edge.typeOnly }),
        whyIncluded: 'aggregated file dependencies in selected scope',
      };
      value.count = (value.count ?? 0) + 1;
      aggregated.set(key, value);
    }
    data.visitedNodes = groups.size;
    data.visitedEdges = graph.edges.length;
    data.nodes = [...groups.values()].sort((a, b) => comparePaths(a.id, b.id)).slice(0, request.maxNodes);
    if (groups.size > data.nodes.length) reasons.push('NODE_LIMIT');
    const ids = new Set(data.nodes.map((node) => node.id));
    const visibleEdges = [...aggregated.values()]
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .sort((a, b) => comparePaths(JSON.stringify(a), JSON.stringify(b)));
    data.edges = visibleEdges.slice(0, request.maxEdges);
    if (visibleEdges.length > data.edges.length) reasons.push('EDGE_LIMIT');
  } else {
    const root = request.root;
    const relations = CodeMapQuerySchema.parse({
      kind: 'relations',
      ...root,
      ...(request.paths ? { path: request.paths[0] ?? 'unused' } : {}),
      direction: request.view === 'impact' ? 'incoming' : request.direction,
      relations: request.view === 'file' ? [...new Set([...request.relations, 'contains'])] : request.relations,
      depth: request.depth,
      includeHeuristic: request.includeHeuristic,
    });
    if (relations.kind !== 'relations') throw new Error('Invalid relation projection');
    if (request.view === 'impact') relations.relations = relations.relations.filter((rel) => rel !== 'contains');
    const index = neighbors ?? new CodeRelations(graph);
    const neighborhood =
      request.view === 'impact' && (request.paths || (root && 'path' in root))
        ? index.dependents(request.paths ?? [(root as { path: string }).path], relations)
        : index.query(relations);
    if (!neighborhood.data) return { data: null, reasons };
    if (request.root && !neighborhood.data.nodes.length) return { data: null, reasons };
    const files = new Map(graph.files.map((file) => [file.id, file]));
    data.nodes = neighborhood.data.nodes
      .map((node) => {
        const value = node.value;
        if (node.kind === 'file')
          return {
            id: value.id,
            kind: 'file' as const,
            label: node.value.path,
            path: node.value.path,
            sha256: node.value.sha256,
            stale: !!node.value.stale,
            whyIncluded: node.whyIncluded,
          };
        if (node.kind === 'symbol')
          return {
            id: value.id,
            kind: 'symbol' as const,
            label: node.value.name,
            path: files.get(node.value.file)?.path,
            sha256: files.get(node.value.file)?.sha256,
            symbolKind: node.value.kind,
            signature: node.value.signature,
            span: node.value.span,
            stale: !!node.value.stale,
            whyIncluded: node.whyIncluded,
          };
        if (node.kind === 'group')
          return {
            id: value.id,
            kind: 'group' as const,
            label: node.value.name ?? node.value.path,
            path: node.value.path,
            files: node.value.files,
            whyIncluded: node.whyIncluded,
          };
        return { id: value.id, kind: 'package' as const, label: node.value.name, whyIncluded: node.whyIncluded };
      })
      .filter((node) => !request.pathPrefix || !node.path || withinPrefix(node.path, request.pathPrefix));
    const all = data.nodes.length;
    data.nodes = data.nodes.slice(0, request.maxNodes);
    if (all > data.nodes.length) reasons.push('NODE_LIMIT');
    const ids = new Set(data.nodes.map((node) => node.id));
    const edges = neighborhood.data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    data.edges = edges.slice(0, request.maxEdges);
    if (edges.length > data.edges.length) reasons.push('EDGE_LIMIT');
    if (neighborhood.truncated) reasons.push('VISIT_LIMIT');
    data.visitedNodes = neighborhood.data.visitedNodes;
    data.visitedEdges = neighborhood.data.visitedEdges;
  }
  return { data, reasons };
}
