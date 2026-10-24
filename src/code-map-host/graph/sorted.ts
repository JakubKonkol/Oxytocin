type Compare<T> = (left: T, right: T) => number;

/** `items` in `compare` order; elements that compare equal are one element when `unique` is set. */
export function sortedFrom<T>(items: readonly T[], compare: Compare<T>, unique: boolean): T[] {
  const sorted = [...items].sort(compare);
  if (!unique) return sorted;
  const output: T[] = [];
  for (const item of sorted) if (!output.length || compare(output[output.length - 1]!, item) !== 0) output.push(item);
  return output;
}

/** First index whose element is not smaller than `item`. */
function lowerBound<T>(items: readonly T[], item: T, compare: Compare<T>): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(items[middle]!, item) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** `items` without the elements at the ascending `positions`, copied in a few large slices. */
function withoutPositions<T>(items: readonly T[], positions: readonly number[]): T[] {
  if (!positions.length) return [...items];
  const parts: T[][] = [];
  let start = 0;
  for (const position of positions) {
    if (position > start) parts.push(items.slice(start, position));
    start = position + 1;
  }
  parts.push(items.slice(start));
  return concatenate(parts);
}

/** Joins the slices; callers keep their number small enough to spread. */
function concatenate<T>(parts: readonly T[][]): T[] {
  return ([] as T[]).concat(...parts);
}

/**
 * The previous sorted result without `removed`, with the `added` elements merged in. Equals sorting the new element
 * set from scratch when `compare` is a total order on the content of the elements (equal-comparing elements have
 * equal content), `removed` holds exactly the previous elements that are gone and `added` exactly the new ones.
 * Positions are found by binary search, so only copying (not comparing) is proportional to the result size.
 */
export function mergeSorted<T>(
  previous: readonly T[],
  removed: ReadonlySet<T>,
  added: readonly T[],
  compare: Compare<T>,
  unique: boolean,
): T[] {
  const positions: number[] = [];
  for (const item of removed)
    for (let index = lowerBound(previous, item, compare); index < previous.length; index++) {
      if (previous[index] === item) {
        positions.push(index);
        break;
      }
      if (compare(previous[index]!, item) !== 0) break;
    }
  positions.sort((left, right) => left - right);
  const kept = withoutPositions(previous, positions);
  const fresh = [...added].sort(compare);
  if (!fresh.length) return kept;
  const parts: T[][] = [];
  let start = 0;
  let last: T | undefined;
  let lastIndex = -1;
  for (const item of fresh) {
    const index = lowerBound(kept, item, compare);
    if (unique) {
      if (index < kept.length && compare(kept[index]!, item) === 0) continue;
      if (last !== undefined && lastIndex === index && compare(last, item) === 0) continue;
    }
    if (index > start) parts.push(kept.slice(start, index));
    start = Math.max(start, index);
    parts.push([item]);
    last = item;
    lastIndex = index;
  }
  parts.push(kept.slice(start));
  return concatenate(parts);
}
