/**
 * Sorts `current` (and optionally removes elements that compare equal) by reusing the sorted result of the previous
 * build. Elements that are the same object in both builds keep their relative order, so only new elements are
 * sorted and merged in. The result equals sorting `current` from scratch, provided `compare` is a total order on
 * the content of the elements (equal-comparing elements have equal content).
 */
export function sortedFrom<T extends object>(
  current: readonly T[],
  previous: readonly T[] | undefined,
  compare: (left: T, right: T) => number,
  unique: boolean,
): T[] {
  let kept: T[] = [];
  let fresh: T[];
  if (previous?.length) {
    const now = new Set<T>(current);
    const before = new Set<T>(previous);
    kept = previous.filter((item) => now.has(item));
    fresh = current.filter((item) => !before.has(item));
  } else fresh = [...current];
  fresh.sort(compare);
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
