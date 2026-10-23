import type { CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapQueryData } from '@shared/domain/code-map-query';
import { comparePaths } from '../enumerate';
import { decodeDoc, type SearchCorpus } from './corpus';
import { searchTerms, terms } from './terms';

export { searchTerms, terms };
type Match = Extract<CodeMapQueryData, { kind: 'search' }>['matches'][number];
export interface SearchResult {
  matches: Match[];
  truncated: boolean;
  /** Share (0-1) of the query's idf weight matched by the best result. Absent when nothing matched. */
  coverage?: number;
  /** The best result matched the question in its own name (or is an exact identifier or path match). */
  strong?: boolean;
}
export const withinPrefix = (path: string, prefix?: string): boolean =>
  !prefix || path === prefix || path.startsWith(`${prefix}/`);

/** Field weights and BM25 parameters; see docs/planned-features/code-map/remediation-plan.md (phase 2). */
const NAME_WEIGHT = 3;
const PATH_WEIGHT = 1.75;
const K1 = 1.2;
const B = 0.75;
const TEST_PENALTY = 0.35;
const TEXT_PENALTY = 0.5;
const MAX_QUERY_TERMS = 30;
/** Share of the question's idf weight that the best result must carry in its own name to count as strong. */
const STRONG_NAME_SHARE = 0.35;
const TESTS_MENTIONED = /\b(tests?|specs?|fixtures?|mocks?|mocking|stubs?|e2e|vitest|jest|playwright|testy|testach)\b/u;
const TEXT_FILE = /\.(md|mdx|txt|json)$/i;
const TEXT_MENTIONED = /\b(docs?|documentation|readme|json|changelog|dokumentacj\p{L}*|config(?:uration)? files?)\b/u;

/**
 * Identifiers and paths a question names in code style: camelCase, PascalCase, snake_case, dotted calls, backticked
 * words, and file paths. Plain words and ALL-CAPS words (`HEAD`, `MCP`) are ordinary vocabulary, not identifiers.
 */
function quotedNames(query: string): { names: string[]; paths: string[] } {
  const names = new Set<string>();
  const paths = new Set<string>();
  const quoted = new Set([...query.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()));
  for (const raw of query.split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}_$./@-]+|[^\p{L}\p{N}_$/]+$/gu, '');
    if (token.length < 3) continue;
    const ticked = quoted.has(token);
    if (/^[\w$@.-]+(\/[\w$@.-]+)+$/.test(token) || /^[\w-]+(\.[\w-]+)*\.[a-z]{1,5}$/i.test(token)) {
      if (token.includes('/') || /\.(?:[cm]?[jt]sx?|json|md|py|go|java|cs|css|html|ya?ml|toml)$/i.test(token))
        paths.add(token.toLowerCase());
      continue;
    }
    for (const part of token.split('.'))
      if (/^[A-Za-z_$][\w$]*$/.test(part) && part.length >= 3 && (ticked || /[a-z\d][A-Z]|_/.test(part)))
        names.add(part.toLowerCase());
  }
  return { names: [...names], paths: [...paths] };
}

interface Doc {
  match: Match;
  name: string;
  path: string;
  test: boolean;
  text: boolean;
  /** BM25 document length in indexed tokens. */
  length: number;
}
interface Accumulator {
  name: number;
  path: number;
  body: number;
  /** Bit i: query term i occurs in some field of the document; `nameMask`: in its name. */
  mask: number;
  nameMask: number;
}

/**
 * Ranks files and symbols of exactly one published generation. A term index is built once from the graph and
 * the generation's search corpus (body and file-residual terms); without a corpus the index covers only names,
 * paths and signatures.
 */
export class CodeSearch {
  private readonly docs: Doc[] = [];
  private readonly vocabulary = new Map<string, number>();
  /** Per term id: number of documents containing the term in any field. */
  private readonly frequency: number[] = [];
  private readonly bodyDocs: number[][] = [];
  private readonly bodyCounts: number[][] = [];
  private readonly nameDocs: number[][] = [];
  /** Per term id: files whose path contains the term. */
  private readonly pathFiles: number[][] = [];
  private readonly fileRanges: [number, number][] = [];
  private readonly byName = new Map<string, number[]>();
  private readonly byFilePath = new Map<string, number>();
  private averageLength = 1;

  constructor(graph: CodeMapGraph, corpus?: SearchCorpus) {
    const symbols = new Map<string, CodeMapGraph['symbols']>();
    for (const symbol of graph.symbols) {
      const list = symbols.get(symbol.file);
      if (list) list.push(symbol);
      else symbols.set(symbol.file, [symbol]);
    }
    const term = (text: string): number => {
      let id = this.vocabulary.get(text);
      if (id === undefined) {
        id = this.vocabulary.size;
        this.vocabulary.set(text, id);
        this.frequency.push(0);
        this.bodyDocs.push([]);
        this.bodyCounts.push([]);
        this.nameDocs.push([]);
        this.pathFiles.push([]);
      }
      return id;
    };
    const nameTerms = new Map<string, number[]>();
    const lastSeen: number[] = [];
    let totalLength = 0;
    let measured = 0;
    for (const [fileIndex, file] of graph.files.entries()) {
      const stored = corpus?.get(file.path);
      const pathTerms = searchTerms(file.path).map(term);
      for (const id of pathTerms) this.pathFiles[id]!.push(fileIndex);
      const fileTerms = stored?.search.terms.map(term) ?? [];
      const text = TEXT_FILE.test(file.path);
      const start = this.docs.length;
      const lowerPath = file.path.toLowerCase();
      this.byFilePath.set(lowerPath, fileIndex);
      const add = (
        match: Match,
        body: { n: number; index: number[]; count: number[] } | undefined,
        fallback: string,
      ) => {
        const docIndex = this.docs.length;
        const name = match.name.toLowerCase();
        const doc: Doc = { match, name, path: lowerPath, test: file.test, text, length: 0 };
        this.docs.push(doc);
        const seen = (id: number) => {
          if (lastSeen[id] !== docIndex) {
            lastSeen[id] = docIndex;
            this.frequency[id]!++;
          }
        };
        for (const id of pathTerms) seen(id);
        let nameIds = nameTerms.get(match.name);
        if (!nameIds) nameTerms.set(match.name, (nameIds = searchTerms(match.name).map(term)));
        for (const id of nameIds) {
          this.nameDocs[id]!.push(docIndex);
          seen(id);
        }
        if (body) {
          doc.length = body.n;
          body.index.forEach((local, i) => {
            const id = fileTerms[local]!;
            this.bodyDocs[id]!.push(docIndex);
            this.bodyCounts[id]!.push(body.count[i]!);
            seen(id);
          });
        } else if (fallback) {
          const own = searchTerms(fallback);
          doc.length = own.length;
          for (const text of own) {
            const id = term(text);
            this.bodyDocs[id]!.push(docIndex);
            this.bodyCounts[id]!.push(1);
            seen(id);
          }
        }
        if (doc.length) {
          totalLength += doc.length;
          measured++;
        }
        const named = this.byName.get(name);
        if (named) named.push(docIndex);
        else this.byName.set(name, [docIndex]);
      };
      const termCount = stored?.search.terms.length ?? 0;
      add(
        {
          id: file.id,
          path: file.path,
          name: file.path.split('/').at(-1)!,
          kind: 'file',
          stale: !!file.stale,
          score: 0,
          whyIncluded: [],
        },
        stored ? decodeDoc(stored.search.residual, termCount) : undefined,
        '',
      );
      const bySymbol = new Map<string, ReturnType<typeof decodeDoc>>();
      stored?.symbolIds.forEach((id, i) => bySymbol.set(id, decodeDoc(stored.search.symbols[i]!, termCount)));
      for (const symbol of symbols.get(file.id) ?? [])
        add(
          {
            id: symbol.id,
            path: file.path,
            name: symbol.name,
            kind: symbol.kind,
            signature: symbol.signature,
            span: symbol.span,
            stale: !!symbol.stale || !!file.stale,
            score: 0,
            whyIncluded: [],
          },
          bySymbol.get(symbol.id),
          symbol.signature ?? '',
        );
      this.fileRanges.push([start, this.docs.length]);
    }
    this.averageLength = measured ? totalLength / measured : 1;
  }

  search(query: string, prefix: string | undefined, limit: number): SearchResult {
    const exact = query.trim().toLowerCase();
    const known = searchTerms(query)
      .map((text) => ({ text, id: this.vocabulary.get(text) }))
      .filter((entry): entry is { text: string; id: number } => entry.id !== undefined)
      .map((entry) => ({ ...entry, weight: this.idf(entry.id) }))
      .sort((a, b) => b.weight - a.weight || comparePaths(a.text, b.text))
      .slice(0, MAX_QUERY_TERMS);
    const totalWeight = known.reduce((sum, entry) => sum + entry.weight, 0);
    const accumulators = new Map<number, Accumulator>();
    const touch = (doc: number) => {
      let accumulator = accumulators.get(doc);
      if (!accumulator) accumulators.set(doc, (accumulator = { name: 0, path: 0, body: 0, mask: 0, nameMask: 0 }));
      return accumulator;
    };
    known.forEach(({ id, weight }, bit) => {
      const flag = 1 << bit;
      for (const doc of this.nameDocs[id]!) {
        const accumulator = touch(doc);
        accumulator.name += weight;
        accumulator.mask |= flag;
        accumulator.nameMask |= flag;
      }
      for (const file of this.pathFiles[id]!) {
        const [from, to] = this.fileRanges[file]!;
        for (let doc = from; doc < to; doc++) {
          const accumulator = touch(doc);
          accumulator.path += weight;
          accumulator.mask |= flag;
        }
      }
      const docs = this.bodyDocs[id]!,
        counts = this.bodyCounts[id]!;
      for (let i = 0; i < docs.length; i++) {
        const accumulator = touch(docs[i]!),
          tf = counts[i]!;
        accumulator.body +=
          (weight * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * this.docs[docs[i]!]!.length) / this.averageLength));
        accumulator.mask |= flag;
      }
    });
    // An identifier or path named in the question outranks lexical scores; a question that is only one
    // identifier or path restricts the answer to its exact matches.
    const quoted = quotedNames(query);
    const nameHits = new Set<number>(),
      pathHits = new Set<number>(),
      only = new Set<number>();
    for (const doc of this.byName.get(exact) ?? []) only.add(doc);
    const exactFile = this.byFilePath.get(exact);
    if (exactFile !== undefined) {
      const [from, to] = this.fileRanges[exactFile]!;
      for (let doc = from; doc < to; doc++) only.add(doc);
    }
    for (const name of quoted.names) for (const doc of this.byName.get(name) ?? []) nameHits.add(doc);
    for (const path of quoted.paths) {
      const file = this.byFilePath.get(path);
      if (file !== undefined) pathHits.add(this.fileRanges[file]![0]);
    }
    for (const doc of [...nameHits, ...pathHits]) touch(doc);
    if (only.size) for (const doc of [...accumulators.keys()]) if (!only.has(doc)) accumulators.delete(doc);
    for (const doc of only) touch(doc);

    const testsWanted = TESTS_MENTIONED.test(exact),
      textWanted = TEXT_MENTIONED.test(exact);
    interface Ranked {
      doc: Doc;
      score: number;
      why: string[];
      coverage: number;
      nameShare: number;
    }
    const ranked: Ranked[] = [];
    for (const [index, accumulator] of accumulators) {
      const doc = this.docs[index]!;
      if (!withinPrefix(doc.match.path, prefix)) continue;
      let weight = 0,
        nameWeight = 0;
      known.forEach((entry, bit) => {
        if (accumulator.mask & (1 << bit)) weight += entry.weight;
        if (accumulator.nameMask & (1 << bit)) nameWeight += entry.weight;
      });
      const coverage = totalWeight ? weight / totalWeight : 0;
      let score =
        (NAME_WEIGHT * accumulator.name + PATH_WEIGHT * accumulator.path + accumulator.body) * coverage * coverage;
      const why = known.filter((_, bit) => accumulator.mask & (1 << bit)).map((entry) => `term:${entry.text}`);
      const exactName = doc.name === exact || nameHits.has(index),
        exactPath = doc.path === exact || pathHits.has(index);
      if (exactName) {
        score += 120;
        why.push('exact name');
      }
      if (exactPath) {
        score += 150;
        why.push('exact path');
      }
      if (doc.test && !testsWanted) {
        score *= TEST_PENALTY;
        why.push('test file ranked lower');
      }
      if (doc.text && !textWanted) {
        score *= TEXT_PENALTY;
        why.push('text file ranked lower');
      }
      if (score > 0)
        ranked.push({
          doc,
          score,
          why,
          coverage: exactName || exactPath ? 1 : coverage,
          nameShare: exactName || exactPath ? 1 : totalWeight ? nameWeight / totalWeight : 0,
        });
    }
    const order = (a: Ranked, b: Ranked) =>
      b.score - a.score || comparePaths(a.doc.path, b.doc.path) || comparePaths(a.doc.match.id, b.doc.match.id);
    ranked.sort(order);
    // A file scores by its best document plus a little for the next two, so a file with several matching
    // symbols outranks one with a single equally good symbol; its lead is the best document.
    const files = new Map<string, Ranked[]>();
    for (const item of ranked) {
      const list = files.get(item.doc.match.path);
      if (list) list.push(item);
      else files.set(item.doc.match.path, [item]);
    }
    const groups = [...files.values()]
      .map((list) => ({
        lead: list[0]!,
        score: list[0]!.score + 0.25 * (list[1]?.score ?? 0) + 0.1 * (list[2]?.score ?? 0),
      }))
      .sort((a, b) => b.score - a.score || order(a.lead, b.lead));
    // First the best document of each file, then further symbols of those files by their own score.
    const leads = new Map(groups.map((group) => [group.lead, group.score]));
    const selected = [...groups.map((group) => group.lead), ...ranked.filter((item) => !leads.has(item))].slice(
      0,
      limit,
    );
    const top = groups[0]?.lead;
    return {
      matches: selected.map((item) => ({
        ...item.doc.match,
        score: leads.get(item) ?? item.score,
        whyIncluded: item.why,
      })),
      truncated: ranked.length > selected.length,
      ...(top ? { coverage: Math.round(top.coverage * 1000) / 1000, strong: top.nameShare >= STRONG_NAME_SHARE } : {}),
    };
  }

  private idf(id: number): number {
    const df = this.frequency[id]!;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }
}
