import { describe, expect, it } from 'vitest';
import { mergeSorted, sortedFrom } from './sorted';

interface Item {
  key: number;
  tag: string;
}
const compare = (left: Item, right: Item) =>
  left.key - right.key || (left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0);
/** Small pseudo-random generator so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('merging into a previous sorted order', () => {
  for (const unique of [true, false])
    it(`equals sorting the new set from scratch (unique: ${unique})`, () => {
      const next = random(unique ? 7 : 11);
      const make = (): Item => ({
        key: Math.floor(next() * 40),
        tag: String.fromCharCode(97 + Math.floor(next() * 3)),
      });
      for (let round = 0; round < 300; round++) {
        const drawn = Array.from({ length: Math.floor(next() * 60) }, make);
        // A build never loses an element to a dropped equal twin: equal edges share one source.
        const alive = unique ? drawn.filter((item, i) => drawn.findIndex((o) => compare(o, item) === 0) === i) : drawn;
        const previous = sortedFrom(alive, compare, unique);
        // Remove some of the objects that made it into the previous order, add new ones (also equal-comparing ones).
        const removed = new Set(previous.filter(() => next() < 0.2));
        const added = Array.from({ length: Math.floor(next() * 15) }, make);
        const current = [...alive.filter((item) => !removed.has(item)), ...added];
        const expected = sortedFrom(current, compare, unique);
        const merged = mergeSorted(previous, removed, added, compare, unique);
        expect(merged.map((item) => `${item.key}${item.tag}`)).toEqual(
          expected.map((item) => `${item.key}${item.tag}`),
        );
      }
    });
  it('keeps the previous array untouched', () => {
    const previous = sortedFrom(
      [
        { key: 1, tag: 'a' },
        { key: 3, tag: 'a' },
      ],
      compare,
      true,
    );
    const copy = [...previous];
    mergeSorted(previous, new Set([previous[0]!]), [{ key: 2, tag: 'a' }], compare, true);
    expect(previous).toEqual(copy);
  });
});
