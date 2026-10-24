import { posix } from 'node:path';
import { CODE_MAP_LIMITS, emptyCodeMapCoverage, type CodeMapEdge, type CodeMapGraph } from '@shared/domain/code-map';
import { comparePaths, CodeMapLimitError } from '../enumerate';
import type { FileRecord } from '../extract/record';
import type { ProjectConfig } from '../resolve/config';
import { ModuleResolver } from '../resolve/modules';
import { ResolutionCache, type FileResolution } from './resolution-cache';
import { mergeSorted, sortedFrom } from './sorted';
import { BindingResolver } from '../resolve/bindings';
import { CSharpResolver } from '../resolve/csharp';
import { GoResolver } from '../resolve/go';
import { JavaResolver } from '../resolve/java';
import { PythonResolver } from '../resolve/python';

const compareEdges = (left: CodeMapGraph['edges'][number], right: CodeMapGraph['edges'][number]): number =>
  comparePaths(left.from, right.from) ||
  comparePaths(left.rel, right.rel) ||
  comparePaths(left.to, right.to) ||
  (left.at?.[0] ?? 0) - (right.at?.[0] ?? 0) ||
  (left.at?.[1] ?? 0) - (right.at?.[1] ?? 0) ||
  comparePaths(left.prov, right.prov) ||
  Number(left.typeOnly ?? false) - Number(right.typeOnly ?? false) ||
  Number(!!left.at) - Number(!!right.at) ||
  (left.typeOnly === right.typeOnly ? 0 : left.typeOnly === undefined ? -1 : 1);
const compareUnresolved = (
  left: CodeMapGraph['unresolved'][number],
  right: CodeMapGraph['unresolved'][number],
): number =>
  comparePaths(left.from, right.from) ||
  comparePaths(left.rel, right.rel) ||
  comparePaths(left.target, right.target) ||
  (left.at?.[0] ?? 0) - (right.at?.[0] ?? 0) ||
  (left.at?.[1] ?? 0) - (right.at?.[1] ?? 0) ||
  comparePaths(left.reason, right.reason);

export function buildGraph(
  records: ReadonlyMap<string, FileRecord>,
  configs: ReadonlyMap<string, ProjectConfig>,
  generator: CodeMapGraph['generator'],
  skipped = 0,
  limits: { files: number; symbols: number; edges: number } = CODE_MAP_LIMITS,
  /** Reuses the relations of files whose inputs did not change; the result equals a build without it. */
  resolution?: ResolutionCache,
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
  // Without a cache everything is built from scratch, which is what an incremental build must equal.
  const cache = resolution ?? new ResolutionCache();
  const groups = new Map<string, CodeMapGraph['groups'][number]>();
  const ordered = [...records].sort(([left], [right]) => comparePaths(left, right));
  // What each source contributed to the edges, to merge into the previous order instead of sorting everything.
  const ownByPath = new Map<string, CodeMapEdge[]>();
  const entryByPath = new Map<string, FileResolution>();
  const volatileEdges: CodeMapEdge[] = [];
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
    // The containment edges of an unchanged record are the same objects in every build (without C# merging).
    const cacheable = !csharp || !record.csharp;
    const reused = cacheable ? cache.containment.get(record) : undefined;
    const own: CodeMapEdge[] = reused ?? [
      { from: record.file.group, to: record.file.id, rel: 'contains', prov: 'syntax' },
    ];
    for (const symbol of record.symbols) {
      if (graph.symbols.length >= limits.symbols || graph.edges.length + own.length >= limits.edges)
        throw new CodeMapLimitError();
      const owner = symbol.owner ? (csharp?.aliases.get(symbol.owner) ?? symbol.owner) : null;
      const primary = csharp?.aliases.get(symbol.id);
      if (primary) {
        // A further partial declaration: the merged type keeps one symbol and lists this span as a part.
        own.push({
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
      if (!reused)
        own.push({
          from: owner ?? record.file.id,
          to: symbol.id,
          rel: 'contains',
          prov: 'syntax',
          at: [symbol.span[0], symbol.span[1]],
        });
    }
    if (cacheable && !reused) cache.containment.set(record, own);
    ownByPath.set(record.file.path, own);
    for (const edge of own) graph.edges.push(edge);
  }
  for (const group of groups.values()) {
    if (group.parent) {
      const edge: CodeMapEdge = { from: group.parent, to: group.id, rel: 'contains', prov: 'syntax' };
      graph.edges.push(edge);
      volatileEdges.push(edge);
    }
    if (graph.edges.length > limits.edges) throw new CodeMapLimitError();
  }
  let resolver: BindingResolver | undefined;
  const exportedSymbols = new Set<string>();
  const packages = new Set<string>();
  cache.begin(records, configs);
  const index = cache.index;
  for (const [path] of ordered) {
    let entry = cache.lookup(path);
    if (!entry) {
      resolver ??= new BindingResolver(new ModuleResolver(records, configs), index);
      const output = {
        edges: [] as CodeMapGraph['edges'],
        unresolved: [] as CodeMapGraph['unresolved'],
        packages: new Set<string>(),
        exported: [] as string[],
      };
      const { deps } = resolver.track(() =>
        resolver!.appendRelations(
          path,
          output.edges,
          output.unresolved,
          output.packages,
          limits.edges,
          output.exported,
        ),
      );
      const stored = { ...output, packages: [...output.packages] };
      entry = cache.store(path, deps, stored);
    }
    entryByPath.set(path, entry);
    for (const edge of entry.edges) graph.edges.push(edge);
    for (const item of entry.unresolved) graph.unresolved.push(item);
    for (const name of entry.packages) packages.add(name);
    for (const id of entry.exported) exportedSymbols.add(id);
    if (graph.edges.length > limits.edges || graph.unresolved.length > limits.edges) throw new CodeMapLimitError();
  }
  const relationsEnd = { edges: graph.edges.length, unresolved: graph.unresolved.length };
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
  for (const symbol of graph.symbols) if (exportedSymbols.has(symbol.id)) symbol.exported = true;
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
  // Edges equal in every field are one edge. Sources that did not change contribute the same edge objects as in the
  // previous build, so only the edges of changed sources are sorted and merged into the previous order.
  for (let index = relationsEnd.edges; index < graph.edges.length; index++) volatileEdges.push(graph.edges[index]!);
  const volatileUnresolved = graph.unresolved.slice(relationsEnd.unresolved);
  const previous = cache.published;
  if (previous && cache.mergedBuilds < 50) {
    const removedEdges = new Set<CodeMapEdge>(previous.volatileEdges);
    const addedEdges: CodeMapEdge[] = [...volatileEdges];
    const removedUnresolved = new Set(previous.volatileUnresolved);
    const addedUnresolved = [...volatileUnresolved];
    for (const [path, own] of previous.own)
      if (ownByPath.get(path) !== own) for (const edge of own) removedEdges.add(edge);
    for (const [path, own] of ownByPath)
      if (previous.own.get(path) !== own) for (const edge of own) addedEdges.push(edge);
    for (const [path, entry] of previous.entries)
      if (entryByPath.get(path) !== entry) {
        for (const edge of entry.edges) removedEdges.add(edge);
        for (const item of entry.unresolved) removedUnresolved.add(item);
      }
    for (const [path, entry] of entryByPath)
      if (previous.entries.get(path) !== entry) {
        for (const edge of entry.edges) addedEdges.push(edge);
        for (const item of entry.unresolved) addedUnresolved.push(item);
      }
    graph.edges = mergeSorted(previous.edges, removedEdges, addedEdges, compareEdges, true);
    graph.unresolved = mergeSorted(previous.unresolved, removedUnresolved, addedUnresolved, compareUnresolved, false);
    cache.mergedBuilds++;
  } else {
    graph.edges = sortedFrom(graph.edges, compareEdges, true);
    graph.unresolved = sortedFrom(graph.unresolved, compareUnresolved, false);
    cache.mergedBuilds = 0;
  }
  cache.published = {
    edges: graph.edges,
    unresolved: graph.unresolved,
    own: ownByPath,
    entries: entryByPath,
    volatileEdges,
    volatileUnresolved,
  };
  graph.coverage.files.skipped = skipped;
  graph.coverage.byLanguage = Object.fromEntries(
    Object.entries(graph.coverage.byLanguage).sort(([left], [right]) => comparePaths(left, right)),
  );
  graph.coverage.unresolved.imports = graph.unresolved.filter((entry) => entry.rel === 'imports').length;
  graph.coverage.unresolved.calls = graph.unresolved.filter((entry) => entry.rel === 'calls').length;
  // Assembled only from validated records; readers validate `graph.json` with the schema (tests assert conformance).
  return graph;
}
