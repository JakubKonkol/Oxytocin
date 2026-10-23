import type { FileRecord, FileSearch } from '../extract/record';

/**
 * Search terms of one published generation: the body and residual postings of every indexed file, keyed by file
 * path. A corpus is immutable and belongs to exactly one graph: the engine builds it together with the graph it
 * publishes, and `CodeSearch` ranks only from a (graph, corpus) pair taken from the same snapshot.
 */
export type SearchCorpus = ReadonlyMap<string, { readonly symbolIds: readonly string[]; readonly search: FileSearch }>;

/** Captures the postings of the given records; copies ids so later record updates cannot change the corpus. */
export function buildSearchCorpus(records: ReadonlyMap<string, FileRecord>): SearchCorpus {
  const corpus = new Map<string, { symbolIds: readonly string[]; search: FileSearch }>();
  for (const [path, record] of records)
    if (record.search && record.search.symbols.length === record.symbols.length)
      corpus.set(path, { symbolIds: record.symbols.map((symbol) => symbol.id), search: record.search });
  return corpus;
}

/** Decoded postings of one text region: indexes into the file's term list and their counts. */
export interface DecodedDoc {
  n: number;
  index: number[];
  count: number[];
}
export function decodeDoc(doc: { n: number; t: string }, termCount: number): DecodedDoc {
  const index: number[] = [];
  const count: number[] = [];
  const text = doc.t;
  for (let i = 0; i < text.length;) {
    const start = i;
    let term = 0;
    for (let c = text.charCodeAt(i); c >= 48 && c <= 57; c = text.charCodeAt(++i)) term = term * 10 + c - 48;
    let times = 1;
    if (text.charCodeAt(i) === 42) {
      times = 0;
      for (let c = text.charCodeAt(++i); c >= 48 && c <= 57; c = text.charCodeAt(++i)) times = times * 10 + c - 48;
    }
    if (i > start && term < termCount) {
      index.push(term);
      count.push(Math.max(1, times));
    }
    while (i < text.length && text.charCodeAt(i) === 32) i++;
    if (i === start) i++;
  }
  return { n: doc.n, index, count };
}
