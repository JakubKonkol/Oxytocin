/**
 * Shared text normalization for Code Map search: the same functions split identifiers while a file is extracted
 * (body postings) and while a question is asked, so both sides always agree on a term. Pure and dependency free.
 */

/** Identifier-aware tokens in source order, repeats kept: `getPathForFile` -> get, path, for, file. */
export function tokens(text: string): string[] {
  return (
    text
      // A plural acronym is one word: `ACKs` is `ack`, not `ac ks`.
      .replace(/\b([A-Z]{2,})s\b/g, '$1')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}
/** Unique identifier-aware terms, not stemmed. */
export function terms(text: string): string[] {
  return [...new Set(tokens(text))];
}

const words = (list: string) => new Set(list.split(' '));
/** Question words and English glue that never identify code (plus the Polish words the corpus has asked with). */
export const STOP_WORDS = words(
  'where how what which who when why is are was were be been being the a an in of to for do does did we our us it its ' +
    'this that these those and or not no with from by on at as into than then there their they them can could should ' +
    'will would may might must have has had i you your me my application app gdzie jak co jest sa w z na mamy aplikacji',
);
/** Syntax noise that is in nearly every body; dropped from body postings only (it can still be part of a name). */
const CODE_NOISE = words(
  'const let var return new null undefined true false void this self typeof import export default async await ' +
    'public private protected static readonly extends implements else elif def func fn pub mod string number boolean ' +
    'any unknown object function class interface type enum if for while try catch finally throw switch case break ' +
    'continue yield then of in',
);

// Small, explicit vocabulary normalization, not semantic inference. Keep identifiers intact in `terms`.
const normalize = (term: string) =>
  /^(settings|configuration|configure|configured|configurations|konfiguracj\p{L}*|ustawieni\p{L}*)$/u.test(term)
    ? 'config'
    : term;

const VOWEL = /[aeiouy]/;
/**
 * Light plural and tense folding for ASCII words (`files` -> `file`, `debounced` -> `debounce`, `mappings` ->
 * `map`). The result is only a lookup key, not a word: it is applied identically to documents and questions, so
 * collisions between related forms are the goal.
 */
export function stem(term: string): string {
  if (term.length <= 3 || !/^[a-z]+$/.test(term)) return term;
  let t = term;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (/(sses|xes|ches|shes|zes)$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  for (const suffix of ['ing', 'ed']) {
    if (t.endsWith(suffix)) {
      const base = t.slice(0, -suffix.length);
      if (base.length >= 3 && VOWEL.test(base)) {
        t = /([^aeiouyls])\1$/.test(base) ? base.slice(0, -1) : base;
        break;
      }
    }
  }
  return t.length > 4 && t.endsWith('e') ? t.slice(0, -1) : t;
}

const fold = (token: string) => stem(normalize(token));
/** Unique stemmed question terms without stop words. */
export const searchTerms = (text: string): string[] => [
  ...new Set(
    tokens(text)
      .filter((t) => !STOP_WORDS.has(t))
      .map(fold),
  ),
];

/** Limits of body postings: one symbol or file residual never contributes more than this. */
export const BODY_LIMITS = { lines: 400, chars: 64 * 1024, terms: 2000, tokenLength: 32 } as const;

/**
 * Stemmed term counts of source text for the body index, in first-seen order: identifiers split, comments and
 * string literals included, stop words, syntax noise, numbers and one-letter tokens removed. `total` counts every
 * kept token (the BM25 document length) even when `counts` is cut to the most frequent `BODY_LIMITS.terms`.
 */
export function bodyTerms(text: string): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const token of tokens(text)) {
    if (
      token.length < 2 ||
      token.length > BODY_LIMITS.tokenLength ||
      STOP_WORDS.has(token) ||
      CODE_NOISE.has(token) ||
      /^\d+$/.test(token)
    )
      continue;
    const term = fold(token);
    counts.set(term, (counts.get(term) ?? 0) + 1);
    total++;
  }
  if (counts.size > BODY_LIMITS.terms) {
    const kept = [...counts].sort((a, b) => b[1] - a[1]).slice(0, BODY_LIMITS.terms);
    const keep = new Set(kept.map(([term]) => term));
    return { counts: new Map([...counts].filter(([term]) => keep.has(term))), total };
  }
  return { counts, total };
}
