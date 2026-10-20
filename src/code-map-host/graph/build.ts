import { posix } from 'node:path';
import { CODE_MAP_LIMITS, emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { comparePaths, CodeMapLimitError } from '../enumerate';
import type { FileRecord } from '../extract/record';
import type { ProjectConfig } from '../resolve/config';
import { ModuleResolver } from '../resolve/modules';
import { BindingResolver } from '../resolve/bindings';
import { CSharpResolver } from '../resolve/csharp';
import { GoResolver } from '../resolve/go';
import { JavaResolver } from '../resolve/java';
import { PythonResolver } from '../resolve/python';

export function buildGraph(
  records: ReadonlyMap<string, FileRecord>,
  configs: ReadonlyMap<string, ProjectConfig>,
  generator: CodeMapGraph['generator'],
  skipped = 0,
  limits: { files: number; symbols: number; edges: number } = CODE_MAP_LIMITS,
): CodeMapGraph {
  if (records.size > limits.files) throw new CodeMapLimitError();
  const graph: CodeMapGraph = {
    format: 'oxytocin.code-map',
    schemaVersion: 1,
    generator,
    groups: [],
    files: [],
    packages: [],
    symbols: [],
    edges: [],
    unresolved: [],
    coverage: emptyCodeMapCoverage(),
  };
  const groups = new Map<string, CodeMapGraph['groups'][number]>();
  const ordered = [...records].sort(([left], [right]) => comparePaths(left, right));
  const csharp =
    [...records.values()].some((record) => record.csharp) ||
    [...configs.values()].some((config) => config.kind.startsWith('dotnet-'))
      ? new CSharpResolver(records, configs)
      : null;
  for (const [, record] of ordered) {
    graph.files.push({ ...record.file, ...(csharp?.isTestFile(record.file.path) ? { test: true } : {}) });
    const category =
      record.file.status === 'unsupported' ? 'unsupported' : record.file.status === 'ok' ? 'indexed' : 'failed';
    graph.coverage.files[category]++;
    graph.coverage.byLanguage[record.file.language] = (graph.coverage.byLanguage[record.file.language] ?? 0) + 1;
    for (let path = posix.dirname(record.file.path); ; path = posix.dirname(path)) {
      let group = groups.get(path);
      if (!group) {
        if (groups.size >= limits.files) throw new CodeMapLimitError('Code Map folder limit reached — add exclusions');
        group = { id: `d:${path}`, path, parent: path === '.' ? null : `d:${posix.dirname(path)}`, files: 0 };
        groups.set(path, group);
      }
      group.files++;
      if (path === '.') break;
    }
    graph.edges.push({ from: record.file.group, to: record.file.id, rel: 'contains', prov: 'syntax' });
    for (const symbol of record.symbols) {
      if (graph.symbols.length >= limits.symbols || graph.edges.length >= limits.edges) throw new CodeMapLimitError();
      const owner = symbol.owner ? (csharp?.aliases.get(symbol.owner) ?? symbol.owner) : null;
      const primary = csharp?.aliases.get(symbol.id);
      if (primary) {
        // A further partial declaration: the merged type keeps one symbol and lists this span as a part.
        graph.edges.push({
          from: owner ?? record.file.id,
          to: primary,
          rel: 'contains',
          prov: 'syntax',
          at: [symbol.span[0], symbol.span[1]],
        });
        continue;
      }
      const parts = csharp?.parts.get(symbol.id);
      graph.symbols.push({ ...symbol, owner, ...(parts ? { parts } : {}) });
      graph.edges.push({
        from: owner ?? record.file.id,
        to: symbol.id,
        rel: 'contains',
        prov: 'syntax',
        at: [symbol.span[0], symbol.span[1]],
      });
    }
  }
  for (const group of groups.values()) {
    if (group.parent) graph.edges.push({ from: group.parent, to: group.id, rel: 'contains', prov: 'syntax' });
    if (graph.edges.length > limits.edges) throw new CodeMapLimitError();
  }
  const resolver = new BindingResolver(new ModuleResolver(records, configs));
  const packages = new Set<string>();
  for (const [path] of ordered) {
    resolver.appendRelations(path, graph.edges, graph.unresolved, packages, limits.edges);
    if (graph.edges.length > limits.edges || graph.unresolved.length > limits.edges) throw new CodeMapLimitError();
  }
  const packageNodes = new Map<string, CodeMapGraph['packages'][number]>(
    [...packages].map((name) => [`p:${name}`, { id: `p:${name}`, name, external: true }]),
  );
  if (csharp) {
    for (const path of csharp.paths) csharp.appendRelations(path, graph.edges, graph.unresolved, limits.edges);
    csharp.appendProjects(
      graph,
      ordered.map(([path]) => path),
      packageNodes,
    );
    csharp.appendFileReferences(graph.edges);
    if (graph.edges.length > limits.edges || graph.unresolved.length > limits.edges) throw new CodeMapLimitError();
    const byId = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
    for (const symbol of graph.symbols)
      if (symbol.visibility) {
        symbol.visibility = csharp.visibility.get(symbol.id) ?? symbol.visibility;
        symbol.exported = csharp.exported(symbol, byId);
      }
  }
  graph.groups = [...graph.groups, ...groups.values()].sort((left, right) => comparePaths(left.id, right.id));
  if ([...records.values()].some((r) => r.go))
    new GoResolver(records, configs).append(graph, packageNodes, limits.edges);
  if ([...records.values()].some((r) => r.java))
    new JavaResolver(records, configs).append(graph, packageNodes, limits.edges);
  if ([...records.values()].some((r) => r.python))
    new PythonResolver(records, configs).append(graph, packageNodes, limits.edges);
  graph.groups.sort((a, b) => comparePaths(a.id, b.id));
  for (const symbol of graph.symbols) if (resolver.exportedSymbols.has(symbol.id)) symbol.exported = true;
  const children = new Map<string, typeof graph.symbols>();
  const namespaceMembers = new Set(
    [...records.values()].flatMap((record) => record.members.map((member) => `${member.owner}\0${member.symbol}`)),
  );
  for (const symbol of graph.symbols)
    if (symbol.owner) {
      const list = children.get(symbol.owner) ?? [];
      list.push(symbol);
      children.set(symbol.owner, list);
    }
  const queue = graph.symbols.filter((symbol) => symbol.exported);
  const expanded = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index]!;
    if (records.get(owner.file.slice(2))?.python) continue;
    if (expanded.has(owner.id) || !['class', 'interface', 'namespace', 'enum'].includes(owner.kind)) continue;
    expanded.add(owner.id);
    for (const child of children.get(owner.id) ?? []) {
      if (
        child.visibility ||
        child.name.startsWith('#') ||
        /^(?:(?:static|readonly|abstract|override|public|async|get|set) )*(?:private|protected) /.test(child.signature)
      )
        continue;
      if (owner.kind === 'namespace' && !namespaceMembers.has(`${owner.id}\0${child.id}`)) continue;
      child.exported = true;
      queue.push(child);
    }
  }
  graph.packages = [...packageNodes.values()].sort((left, right) => comparePaths(left.id, right.id));
  graph.files.sort((left, right) => comparePaths(left.id, right.id));
  graph.symbols.sort((left, right) => comparePaths(left.id, right.id));
  const edges = [
    ...new Map(
      graph.edges.map((edge) => [
        `${edge.from}\0${edge.to}\0${edge.rel}\0${edge.prov}\0${edge.typeOnly}\0${edge.at?.[0]}\0${edge.at?.[1]}`,
        edge,
      ]),
    ).values(),
  ];
  graph.edges = edges.sort(
    (left, right) =>
      comparePaths(left.from, right.from) ||
      comparePaths(left.rel, right.rel) ||
      comparePaths(left.to, right.to) ||
      (left.at?.[0] ?? 0) - (right.at?.[0] ?? 0) ||
      (left.at?.[1] ?? 0) - (right.at?.[1] ?? 0) ||
      comparePaths(left.prov, right.prov) ||
      Number(left.typeOnly ?? false) - Number(right.typeOnly ?? false),
  );
  graph.unresolved.sort(
    (left, right) =>
      comparePaths(left.from, right.from) ||
      comparePaths(left.rel, right.rel) ||
      comparePaths(left.target, right.target) ||
      (left.at?.[0] ?? 0) - (right.at?.[0] ?? 0) ||
      (left.at?.[1] ?? 0) - (right.at?.[1] ?? 0) ||
      comparePaths(left.reason, right.reason),
  );
  graph.coverage.files.skipped = skipped;
  graph.coverage.byLanguage = Object.fromEntries(
    Object.entries(graph.coverage.byLanguage).sort(([left], [right]) => comparePaths(left, right)),
  );
  graph.coverage.unresolved.imports = graph.unresolved.filter((entry) => entry.rel === 'imports').length;
  graph.coverage.unresolved.calls = graph.unresolved.filter((entry) => entry.rel === 'calls').length;
  // Assembled only from validated records; readers validate `graph.json` with the schema (tests assert conformance).
  return graph;
}
