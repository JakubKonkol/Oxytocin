/** `items` in `compare` order; elements that compare equal are one element when `unique` is set. */
export function sortedFrom<T>(items: readonly T[], compare: (left: T, right: T) => number, unique: boolean): T[] {
  return merge([], [...items].sort(compare), compare, unique);
}

/**
 * The previous sorted result without `removed`, merged with the `added` elements. Equals sorting the new element set
 * from scratch when `compare` is a total order on the content of the elements (equal-comparing elements have equal
 * content), `removed` holds exactly the previous elements that are gone and `added` exactly the new ones.
 */
export function mergeSorted<T>(
  previous: readonly T[],
  removed: ReadonlySet<T>,
  added: readonly T[],
  compare: (left: T, right: T) => number,
  unique: boolean,
): T[] {
  return merge(
    removed.size ? previous.filter((item) => !removed.has(item)) : previous,
    [...added].sort(compare),
    compare,
    unique,
  );
}

function merge<T>(
  kept: readonly T[],
  fresh: readonly T[],
  compare: (left: T, right: T) => number,
  unique: boolean,
): T[] {
  const output: T[] = [];
  const emit = (item: T) => {
    if (unique && output.length && compare(output[output.length - 1]!, item) === 0) return;
    output.push(item);
  };
  let left = 0;
  let right = 0;
  while (left < kept.length && right < fresh.length)
    emit(compare(kept[left]!, fresh[right]!) <= 0 ? kept[left++]! : fresh[right++]!);
  while (left < kept.length) emit(kept[left++]!);
  while (right < fresh.length) emit(fresh[right++]!);
  return output;
}
