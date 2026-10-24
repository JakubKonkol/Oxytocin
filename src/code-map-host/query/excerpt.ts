import type { CodeMapExcerpt, CodeMapQueryData } from '@shared/domain/code-map-query';
import { normalizedSource } from '../extract/files';
import { sha256 } from '../store/writer';
import { searchTerms } from './terms';

type Match = Extract<CodeMapQueryData, { kind: 'search' }>['matches'][number];

/** Caps of the source an answer carries. Every line is untrusted data; none of it is ever logged. */
export const EXCERPT_LIMITS = {
  /** Matches that get source: the best of the ranking, which lists distinct files first. */
  hits: 3,
  /** Shown lines per match, signature line and context included. */
  hitLines: 12,
  /** Shown lines per answer. */
  answerLines: 40,
  /** `full`: the whole definition of the first match, up to this many lines. */
  fullLines: 80,
  /** Context around a line that contains question terms. */
  context: 2,
  lineChars: 160,
  /** Longest definition scanned for term lines. */
  scanLines: 1000,
  /** Files larger than this are not read for excerpts. */
  maxBytes: 1024 * 1024,
} as const;
/** JSON bytes of `,"excerpt":` around the value. */
const FIELD_OVERHEAD = 11;
const SCAN_CHARS = 400;

/** One printable line: control and separator characters become spaces, invisible format characters are removed. */
export function cutLine(line: string): string {
  const text = line
    .replace(/\t/g, '  ')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .trimEnd();
  if (text.length <= EXCERPT_LIMITS.lineChars) return text;
  let end = EXCERPT_LIMITS.lineChars - 1;
  // Never split a surrogate pair.
  if (/[\ud800-\udbff]/.test(text[end - 1]!)) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * Lines of one region (1-based, inclusive) that answer a question: the first line (the signature of a definition;
 * `anchor`), then the lines with the most question terms (rarer terms count more), each with `context` lines around
 * it, until `maxLines`. Without an anchor and without a single term line there is nothing to show.
 */
export function selectExcerpt(
  lines: readonly string[],
  region: { from: number; to: number },
  queryTerms: ReadonlySet<string>,
  maxLines: number,
  anchor: boolean,
): CodeMapExcerpt | undefined {
  const { from, to } = region;
  const scanTo = Math.min(to, from + EXCERPT_LIMITS.scanLines - 1);
  const shown = new Set<number>(anchor ? [from] : []);
  const found: { line: number; terms: Set<string> }[] = [];
  const frequency = new Map<string, number>();
  if (queryTerms.size)
    for (let line = from; line <= scanTo; line++) {
      const hit = new Set(searchTerms(lines[line - 1]!.slice(0, SCAN_CHARS)).filter((t) => queryTerms.has(t)));
      if (!hit.size) continue;
      found.push({ line, terms: hit });
      for (const term of hit) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  if (!anchor && !found.length) return undefined;
  const span = scanTo - from + 1;
  const weight = (entry: (typeof found)[number]) =>
    [...entry.terms].reduce((sum, term) => sum + Math.log(1 + span / frequency.get(term)!), 0);
  const ranked = found
    .map((entry) => ({ line: entry.line, weight: weight(entry) }))
    .sort((a, b) => b.weight - a.weight || a.line - b.line);
  for (const { line } of ranked) {
    if (shown.size >= maxLines) break;
    // The widest context that still fits; a line that does not fit even alone is skipped.
    for (let context = EXCERPT_LIMITS.context; context >= 0; context--) {
      const chunk: number[] = [];
      for (let n = Math.max(from, line - context); n <= Math.min(to, line + context); n++)
        if (!shown.has(n)) chunk.push(n);
      if (shown.size + chunk.length <= maxLines) {
        for (const n of chunk) shown.add(n);
        break;
      }
    }
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const segments: CodeMapExcerpt['segments'] = [];
  for (const line of sorted) {
    const last = segments.at(-1);
    if (last && last.start + last.lines.length === line) last.lines.push(cutLine(lines[line - 1]!));
    else segments.push({ start: line, lines: [cutLine(lines[line - 1]!)] });
  }
  return { segments, omitted: to - from + 1 - sorted.length };
}

export interface ExcerptSources {
  /** The indexed file of a path (hash and size of the content the graph was built from). */
  file(path: string): { sha256: string; bytes: number; stale?: boolean | undefined } | undefined;
  /** Current content of the file as it is on disk. */
  read(path: string, signal?: AbortSignal): Promise<string>;
}
const countLines = (excerpt: CodeMapExcerpt) => excerpt.segments.reduce((sum, s) => sum + s.lines.length, 0);

/**
 * Adds source to the best matches of a search. A file is used only when its current content hashes to the indexed
 * hash and the match is not stale; anything else (changed, unreadable, too large) leaves the pointer alone. A match
 * only gets an excerpt while the answer's JSON stays within `budget` characters. Never throws for a file problem.
 */
export async function attachExcerpts(input: {
  matches: Match[];
  query: string;
  mode: 'terms' | 'full';
  /** Characters the JSON envelope may still grow by. */
  budget: number;
  sources: ExcerptSources;
  signal?: AbortSignal;
}): Promise<Match[]> {
  const { matches, mode, sources, signal } = input;
  const chosen = matches.slice(0, mode === 'full' ? 1 : EXCERPT_LIMITS.hits).filter((m) => !m.stale);
  const queryTerms = new Set(searchTerms(input.query));
  const loaded = new Map<string, Promise<string[] | undefined>>();
  const load = (path: string) => {
    let lines = loaded.get(path);
    if (!lines) {
      lines = (async () => {
        try {
          const file = sources.file(path);
          if (!file || file.stale || file.bytes > EXCERPT_LIMITS.maxBytes) return undefined;
          const source = normalizedSource(await sources.read(path, signal));
          return sha256(source) === file.sha256 ? source.split('\n') : undefined;
        } catch {
          return undefined;
        }
      })();
      loaded.set(path, lines);
    }
    return lines;
  };
  const contents = await Promise.all(chosen.map((m) => load(m.path)));
  signal?.throwIfAborted();
  const excerpts = new Map<Match, CodeMapExcerpt>();
  let budget = input.budget,
    used = 0;
  for (const [i, match] of chosen.entries()) {
    const lines = contents[i];
    if (!lines) continue;
    const span = match.span;
    const from = span ? span[0] : 1,
      to = span ? span[2] : lines.length;
    if (from < 1 || to < from || to > lines.length) continue;
    let overBudget = false;
    const attempts: number[] =
      mode === 'full' ? [EXCERPT_LIMITS.fullLines, EXCERPT_LIMITS.hitLines] : [EXCERPT_LIMITS.hitLines];
    for (const [attempt, cap] of attempts.entries()) {
      const room = mode === 'full' && attempt === 0 ? cap : Math.min(cap, EXCERPT_LIMITS.answerLines - used);
      if (room < 1) break;
      const excerpt =
        mode === 'full' && attempt === 0
          ? whole(lines, from, to, cap)
          : selectExcerpt(lines, { from, to }, queryTerms, room, !!span);
      if (!excerpt) break;
      const cost = JSON.stringify(excerpt).length + FIELD_OVERHEAD;
      if (cost > budget) {
        overBudget = true;
        continue;
      }
      excerpts.set(match, excerpt);
      budget -= cost;
      used += countLines(excerpt);
      break;
    }
    // Source is added in rank order: a later match never takes the room of an earlier one that did not fit.
    if (overBudget && !excerpts.has(match)) break;
  }
  return matches.map((match) => (excerpts.has(match) ? { ...match, excerpt: excerpts.get(match)! } : match));
}

/** The first `cap` lines of the definition at `from`-`to`. */
function whole(lines: readonly string[], from: number, to: number, cap: number): CodeMapExcerpt {
  const last = Math.min(to, from + cap - 1);
  return { segments: [{ start: from, lines: lines.slice(from - 1, last).map(cutLine) }], omitted: to - last };
}
