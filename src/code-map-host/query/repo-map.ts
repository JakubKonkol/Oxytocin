import type { CodeMapGraph } from '@shared/domain/code-map';
import type { ProjectConfig } from '../resolve/config';
import { renderMapMarkdown } from '../map-md';
import { withinPrefix } from './search';

export function repoMap(graph: CodeMapGraph, configs: ReadonlyMap<string, ProjectConfig>, prefix?: string): string {
  if (!prefix) return renderMapMarkdown(graph, configs);
  const files = graph.files.filter((file) => withinPrefix(file.path, prefix));
  const fileIds = new Set(files.map((file) => file.id));
  const symbols = graph.symbols.filter((symbol) => fileIds.has(symbol.file));
  const ids = new Set([...fileIds, ...symbols.map((symbol) => symbol.id)]);
  return renderMapMarkdown(
    {
      ...graph,
      files,
      symbols,
      groups: graph.groups.filter((group) => withinPrefix(group.path, prefix)),
      edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    },
    configs,
  );
}
