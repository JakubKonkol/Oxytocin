import type { CodeMapGraph } from '@shared/domain/code-map';
import type { CodeMapQueryData } from '@shared/domain/code-map-query';
import { comparePaths } from '../enumerate';

type Match = Extract<CodeMapQueryData, { kind: 'search' }>['matches'][number];
export const withinPrefix = (path: string, prefix?: string): boolean =>
  !prefix || path === prefix || path.startsWith(`${prefix}/`);
export function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ];
}

/** An inverted index belongs to exactly one immutable published graph. */
export class CodeSearch {
  private readonly entries: { match: Match; name: string; path: string; test: boolean; terms: Set<string> }[] = [];
  private readonly postings = new Map<string, Set<number>>();
  constructor(graph: CodeMapGraph) {
    const files = new Map(graph.files.map((f) => [f.id, f]));
    const add = (match: Match, test: boolean) => {
      const entry = {
        match,
        name: match.name.toLowerCase(),
        path: match.path.toLowerCase(),
        test,
        terms: new Set(terms(`${match.name} ${match.path} ${match.signature ?? ''}`)),
      };
      const index = this.entries.push(entry) - 1;
      for (const term of entry.terms) {
        const posting = this.postings.get(term) ?? new Set<number>();
        posting.add(index);
        this.postings.set(term, posting);
      }
    };
    for (const file of graph.files)
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
        file.test,
      );
    for (const symbol of graph.symbols) {
      const file = files.get(symbol.file);
      if (file)
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
          file.test,
        );
    }
  }
  search(query: string, prefix: string | undefined, limit: number): { matches: Match[]; truncated: boolean } {
    const wanted = terms(query),
      exact = query.toLowerCase();
    const candidates = new Set<number>();
    for (const term of wanted) for (const index of this.postings.get(term) ?? []) candidates.add(index);
    const ranked: Match[] = [];
    for (const index of candidates) {
      const entry = this.entries[index]!;
      if (!withinPrefix(entry.match.path, prefix)) continue;
      const matched = wanted.filter((term) => entry.terms.has(term));
      const why = matched.map((term) => `term:${term}`);
      let score = matched.length * 10 + (matched.length === wanted.length ? 30 : 0);
      if (entry.name === exact) {
        score += 120;
        why.push('exact name');
      }
      if (entry.path === exact) {
        score += 150;
        why.push('exact path');
      }
      if (entry.test) {
        score *= 0.65;
        why.push('test file ranked lower');
      }
      ranked.push({ ...entry.match, score, whyIncluded: why });
    }
    ranked.sort((a, b) => b.score - a.score || comparePaths(a.path, b.path) || comparePaths(a.id, b.id));
    // First offer the strongest match in each file; then fill remaining slots with additional symbols.
    const seen = new Set<string>();
    const unique = ranked.filter((match) => !seen.has(match.path) && !!seen.add(match.path));
    const selected = new Set(unique.slice(0, limit).map((match) => match.id));
    const matches = [...unique, ...ranked.filter((match) => !seen.has(match.path) || !selected.has(match.id))].slice(
      0,
      limit,
    );
    return { matches, truncated: ranked.length > matches.length };
  }
}
