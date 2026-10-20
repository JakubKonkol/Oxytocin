import type { CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapQueryData } from '@shared/domain/code-map-query';

export function fileOutline(graph: CodeMapGraph, path: string): Extract<CodeMapQueryData, { kind: 'outline' }> | null {
  const file = graph.files.find((file) => file.path === path);
  if (!file) return null;
  return {
    kind: 'outline',
    file,
    definitions: graph.symbols.filter(
      (symbol) => symbol.file === file.id || symbol.parts?.some((part) => part.file === file.id),
    ),
    imports: graph.edges.filter((edge) => edge.from === file.id && edge.rel === 'imports'),
  };
}
