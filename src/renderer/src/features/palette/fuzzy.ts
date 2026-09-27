export interface FuzzyMatch {
  score: number;
  /** Matched character positions in the text (for highlighting). */
  indices: number[];
}

const SEPARATORS = new Set([' ', ':', '/', '\\', '-', '_', '.', '(', '[', '@', '#']);

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  if (SEPARATORS.has(prev)) return true;
  const ch = text[i]!;
  // camelCase boundary: "splitRight" → "R".
  return ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
}

/**
 * Case-insensitive subsequence match (docs/plan/02-ui-ux.md §8). Spaces in the query are ignored, so
 * "term split" matches "Terminal: Split Right". Contiguous runs, word starts and an early first match score
 * higher; a contiguous substring match beats a scattered one. Returns null when the query does not match.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  const scattered = matchFrom(text, lower, q);
  const substring = lower.indexOf(q);
  if (substring < 0) return scattered;
  // Prefer the contiguous occurrence, ideally one starting at a word boundary.
  let best = substring;
  for (let i = substring; i >= 0; i = lower.indexOf(q, i + 1)) {
    if (isWordStart(text, i)) {
      best = i;
      break;
    }
  }
  const indices = Array.from({ length: q.length }, (_, k) => best + k);
  const contiguous = { score: scoreIndices(text, indices) + 10, indices };
  return !scattered || contiguous.score >= scattered.score ? contiguous : scattered;
}

/** Greedy match that prefers word starts for each query character. */
function matchFrom(text: string, lower: string, q: string): FuzzyMatch | null {
  const indices: number[] = [];
  let from = 0;
  for (let k = 0; k < q.length; k++) {
    const ch = q[k]!;
    const next = lower.indexOf(ch, from);
    if (next < 0) return null;
    let pick = next;
    // A word start for this character before the next query character would need it wins over a mid-word hit,
    // unless the mid-word hit continues the previous match.
    if (indices.length === 0 || indices.at(-1)! + 1 !== next) {
      for (let i = next; i < lower.length; i++) {
        if (lower[i] === ch && isWordStart(text, i)) {
          if (canFinish(lower, q, k + 1, i + 1)) pick = i;
          break;
        }
      }
    }
    indices.push(pick);
    from = pick + 1;
  }
  return { score: scoreIndices(text, indices), indices };
}

function canFinish(lower: string, q: string, k: number, from: number): boolean {
  for (let i = k; i < q.length; i++) {
    const at = lower.indexOf(q[i]!, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

function scoreIndices(text: string, indices: number[]): number {
  let score = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    score += 1;
    if (isWordStart(text, i)) score += 4;
    if (k > 0 && indices[k - 1] === i - 1) score += 3;
    else if (k > 0) score -= Math.min(3, (i - indices[k - 1]! - 1) * 0.2);
  }
  if (indices[0] === 0) score += 6;
  // Shorter texts win ties ("Terminal: New Terminal" over "Terminal: New Terminal With Profile…").
  return score - text.length * 0.01;
}

/** Splits a label into plain and highlighted runs for the matched indices that fall inside it. */
export function highlightRuns(label: string, indices: readonly number[], offset = 0): { text: string; hit: boolean }[] {
  const hits = new Set(indices.map((i) => i - offset).filter((i) => i >= 0 && i < label.length));
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = hits.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += label[i];
    else runs.push({ text: label[i]!, hit });
  }
  return runs;
}
