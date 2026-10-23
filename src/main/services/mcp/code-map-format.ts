import type { CodeMapQueryResult } from '@shared/domain/code-map-query';
import type { CodeMapFreshness } from '@shared/domain/code-map-plugin';
import type { TaskContextResult } from '@shared/domain/code-map-learning-tools';

// MCP is a reading surface; every character is paid for on each turn of the session. The plugin/IPC schemas retain the
// complete inspection data (coverage, unresolved counts, warnings), and `oxy_code_map_status`/the UI show them.
// An answer is quiet when it is fresh: no header, no coverage totals, no "partial index" boilerplate.
const MAX_SIGNATURE = 120;
/** The compact text of a relations answer; the JSON envelope it was budgeted with is several times larger. */
const RELATIONS_TEXT_BUDGET = 8000;
const SOURCE_STATUS_NOTE: Record<string, string> = {
  failed: 'could not be parsed; its definitions are missing',
  'syntax-errors': 'has syntax errors; its definitions may be incomplete',
  unsupported: 'is indexed as a file only; it has no definitions',
  'skipped-too-large': 'is too large to index; it has no definitions',
};

/** One line of text: newlines and control characters in source can never add result rows. */
const oneLine = (text: string) => text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const signature = (text: string) => clip(oneLine(text), MAX_SIGNATURE);
/** Paths are copied back into tool arguments: print them bare unless that would be ambiguous. */
const path = (value: string) => (/^[^\s"\\\p{Cc}]+$/u.test(value) ? value : JSON.stringify(value));
const location = (file: string, span?: readonly number[]) => `${path(file)}${span ? `:${span[0]}-${span[2]}` : ''}`;
const filePath = (fileId: string) => (fileId.startsWith('f:') ? fileId.slice(2) : fileId);
const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
/** `function foo()` already names its kind; `Foo.bar` does not. */
const describe = (kind: string, text: string) => {
  const line = signature(text);
  return line.startsWith(`${kind} `) ? line : `${kind} ${line}`;
};

/**
 * Nothing for a fresh answer. One short line when the index lags or a cited file is not what the answer was built
 * from; coverage and unresolved totals belong to status.
 */
function note(f: CodeMapFreshness, cited: readonly { path: string; stale?: boolean | undefined }[] = []): string[] {
  if (f.stale || !['ready', 'degraded'].includes(f.state))
    return [
      f.pendingFiles
        ? `stale: index is updating (${files(f.pendingFiles)} changed); results may lag`
        : 'stale: index is not verified yet; results may lag',
    ];
  const stale = [...new Set(cited.filter((c) => c.stale).map((c) => c.path))];
  return stale.length
    ? [
        `stale: ${stale.slice(0, 3).map(path).join(', ')}${stale.length > 3 ? ` and ${stale.length - 3} more` : ''} changed since indexing; lines may lag`,
      ]
    : [];
}
function finish(lines: string[], original: unknown): string {
  const compact = lines.join('\n'),
    json = JSON.stringify(original);
  // Never exceed the already enforced complete response budget, including escaping.
  return compact.length <= json.length ? compact : json;
}
/** "Truncated" only for what the agent asked for and the size budget dropped; more candidates than `limit` is normal. */
function truncation(result: CodeMapQueryResult): string[] {
  if (result.reasons.includes('CHAR_BUDGET'))
    return ['Truncated: size budget reached. Narrow the query, pathPrefix or path.'];
  if (result.reasons.includes('VISIT_LIMIT'))
    return ['Truncated: relation search limit reached. Use depth 1 or one direction.'];
  return [];
}

function relationsLines(data: Extract<NonNullable<CodeMapQueryResult['data']>, { kind: 'relations' }>): {
  lines: string[];
  trimmed: boolean;
} {
  const label = (n: (typeof data.nodes)[number]): string => {
    switch (n.kind) {
      case 'symbol':
        return `${location(filePath(n.value.file), n.value.span)} ${describe(n.value.kind, n.value.signature || n.value.name)}${n.value.stale ? ' STALE' : ''}`;
      case 'file':
        return `${path(n.value.path)} file${n.value.stale ? ' STALE' : ''}`;
      case 'group':
        return `${path(n.value.path)} folder`;
      case 'package':
        return `${oneLine(n.value.name)} package`;
    }
  };
  const build = (count: number) => {
    const kept = data.nodes.slice(0, count),
      ids = new Map(kept.map((n, i) => [n.value.id, i + 1])),
      lines = kept.map((n, i) => `${i + 1} ${label(n)}`);
    for (const e of data.edges)
      if (ids.has(e.from) && ids.has(e.to))
        lines.push(
          `${ids.get(e.from)} -> ${ids.get(e.to)} ${e.rel} [${e.prov}${e.typeOnly ? ', type-only' : ''}]${e.at ? ` at ${e.at[0]}` : ''}`,
        );
    return lines;
  };
  // Keep a connected prefix (nodes are in breadth-first order) until the text fits.
  let count = data.nodes.length,
    lines = build(count);
  while (lines.join('\n').length > RELATIONS_TEXT_BUDGET && count > 1) {
    count = Math.max(1, Math.floor(count * 0.8));
    lines = build(count);
  }
  return { lines, trimmed: count < data.nodes.length };
}

export function formatCodeMap(result: CodeMapQueryResult): string {
  if (!result.freshness || result.data?.kind === 'status') return JSON.stringify(result);
  const data = result.data;
  if (result.code !== 'OK' || !data) return finish([`${result.code}: ${result.hint}`], result);
  const lines: string[] = [];
  if (data.kind === 'search') {
    lines.push(...note(result.freshness, data.matches));
    for (const m of data.matches)
      lines.push(
        m.kind === 'file'
          ? `${path(m.path)} file${m.stale ? ' STALE' : ''}`
          : `${location(m.path, m.span)} ${describe(m.kind, m.signature ?? m.name)}${m.stale ? ' STALE' : ''}`,
      );
    if (!data.matches.length) lines.push('No indexed matches. Use Grep.');
  } else if (data.kind === 'outline') {
    lines.push(...note(result.freshness, [{ path: data.file.path, stale: data.file.stale }]));
    const status = SOURCE_STATUS_NOTE[data.file.status];
    lines.push(`${path(data.file.path)}${data.file.stale ? ' STALE' : ''}${status ? ` ${status}` : ''}`);
    for (const s of data.definitions)
      lines.push(`${s.span[0]}-${s.span[2]} ${signature(s.signature || s.name)}${s.stale ? ' STALE' : ''}`);
    for (const e of data.imports)
      lines.push(`imports ${path(filePath(e.to))}${e.prov === 'heuristic' ? ' [heuristic]' : ''}`);
  } else if (data.kind === 'relations') {
    lines.push(
      ...note(
        result.freshness,
        data.nodes.flatMap((n) =>
          n.kind === 'symbol'
            ? [{ path: filePath(n.value.file), stale: n.value.stale }]
            : n.kind === 'file'
              ? [{ path: n.value.path, stale: n.value.stale }]
              : [],
        ),
      ),
    );
    const { lines: body, trimmed } = relationsLines(data);
    lines.push(...body, 'Indexed code only; not exhaustive.');
    if (trimmed) lines.push('Truncated: size budget reached. Use depth 1 or one direction.');
    else lines.push(...truncation(result));
    return finish(lines, result);
  } else {
    lines.push(...note(result.freshness), data.markdown);
  }
  lines.push(...truncation(result));
  return finish(lines, result);
}

const GENERIC_WARNINGS = [
  'Read current source before editing.',
  'Index updating or degraded;',
  'Search result limit reached;',
  'Memory is unavailable',
];
export function formatTaskContext(result: TaskContextResult): string {
  const lines = [
    ...note(
      result.freshness,
      result.nodes.flatMap((n) => (n.path ? [{ path: n.path, stale: n.stale }] : [])),
    ),
    ...(result.memory === 'unavailable' ? ['memory unavailable; code pointers only'] : []),
  ];
  // Numbers exist only so that relation lines can refer to nodes.
  const ids = new Map(result.nodes.map((n, i) => [n.id, i + 1]));
  for (const n of result.nodes) {
    const where = n.path ? location(n.path, n.span) : oneLine(n.label);
    const what = n.kind === 'symbol' ? describe(n.symbolKind ?? 'symbol', n.signature ?? n.label) : n.kind;
    lines.push(`${result.relations.length ? `${ids.get(n.id)} ` : ''}${where} ${what}${n.stale ? ' STALE' : ''}`);
  }
  for (const e of result.relations) lines.push(`${ids.get(e.from)} -> ${ids.get(e.to)} ${e.rel} [${e.prov}]`);
  // Preserve the exact admitted claim, provenance and evidence; the receipt covers these exact revisions.
  for (const learning of result.learnings) lines.push(`learning: ${JSON.stringify(learning)}`);
  if (result.receipt) lines.push(`receipt=${JSON.stringify(result.receipt)}`);
  if (!result.nodes.length && !result.learnings.length) lines.push('No relevant context. Use Grep.');
  lines.push(
    ...result.warnings
      .filter((w) => !GENERIC_WARNINGS.some((generic) => w.startsWith(generic)))
      .map((w) => `warning: ${oneLine(w)}`),
  );
  return finish(lines, result);
}
