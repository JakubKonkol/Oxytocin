import type { CodeMapSymbol } from '@shared/domain/code-map';
import { BODY_LIMITS, bodyTerms } from '../query/terms';
import type { FileSearch, SearchDoc } from './record';

/** Per-file bounds; a file that exceeds them keeps its documents' lengths but loses the rarest postings. */
const FILE_LIMITS = { dictionary: 20_000, entries: 120_000 } as const;

/** The first lines of a text, bounded by lines and characters. */
function bounded(text: string): string {
  let end = Math.min(text.length, BODY_LIMITS.chars);
  let lines = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1))
    if (++lines >= BODY_LIMITS.lines) {
      end = i;
      break;
    }
  return text.slice(0, end);
}

/**
 * Splits a normalized source into regions: the own text of every symbol (its span minus the spans of symbols nested
 * in it) and the residual (everything outside top-level symbols). Every character belongs to one region, except that
 * symbols with identical spans each keep the text.
 */
function regions(source: string, symbols: readonly Pick<CodeMapSymbol, 'span'>[]): { own: string[]; residual: string } {
  const starts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  const offset = (line: number, column: number) => {
    if (line > starts.length) return source.length;
    const begin = starts[line - 1]!;
    const end = line < starts.length ? starts[line]! - 1 : source.length;
    return Math.min(begin + column, end);
  };
  const ranges = symbols.map(({ span }) => [offset(span[0], span[1]), offset(span[2], span[3])] as const);
  const order = ranges
    .map((_, i) => i)
    .sort((a, b) => ranges[a]![0] - ranges[b]![0] || ranges[b]![1] - ranges[a]![1] || a - b);
  const children: number[][] = ranges.map(() => []);
  const top: number[] = [];
  const stack: number[] = [];
  const contains = (outer: number, inner: number) => {
    const [os, oe] = ranges[outer]!;
    const [is, ie] = ranges[inner]!;
    return os <= is && ie <= oe && (os < is || ie < oe);
  };
  for (const index of order) {
    while (stack.length && !contains(stack.at(-1)!, index)) stack.pop();
    (stack.length ? children[stack.at(-1)!]! : top).push(index);
    stack.push(index);
  }
  const outside = (start: number, end: number, nested: readonly number[]): string => {
    let text = '';
    let cursor = start;
    for (const child of nested) {
      const [cs, ce] = ranges[child]!;
      if (cs > cursor) text += `${source.slice(cursor, cs)}\n`;
      cursor = Math.max(cursor, ce);
    }
    return cursor < end ? text + source.slice(cursor, end) : text;
  };
  return {
    own: ranges.map(([start, end], i) => bounded(outside(start, end, children[i]!))),
    residual: bounded(outside(0, source.length, top)),
  };
}

/**
 * Body and residual term postings of one file. `symbols` are the extracted symbols (spans in the same normalized
 * source); without symbols the file is a file-only text and its bounded prefix is the residual.
 */
export function buildSearchData(source: string, symbols: readonly Pick<CodeMapSymbol, 'span'>[]): FileSearch {
  const dictionary = new Map<string, number>();
  let entries = 0;
  const encode = (text: string): SearchDoc => {
    const { counts, total } = bodyTerms(text);
    const parts: string[] = [];
    for (const [term, count] of counts) {
      let index = dictionary.get(term);
      if (index === undefined) {
        if (dictionary.size >= FILE_LIMITS.dictionary || entries >= FILE_LIMITS.entries) continue;
        index = dictionary.size;
        dictionary.set(term, index);
      }
      if (entries++ >= FILE_LIMITS.entries) break;
      parts.push(count > 1 ? `${index}*${count}` : String(index));
    }
    return { n: total, t: parts.join(' ') };
  };
  const split = symbols.length ? regions(source, symbols) : { own: [], residual: bounded(source) };
  // Residual first: its terms (imports, constants) are few and the most general, so they get the lowest indexes.
  const residual = encode(split.residual);
  const docs = split.own.map(encode);
  return { terms: [...dictionary.keys()], symbols: docs, residual };
}
