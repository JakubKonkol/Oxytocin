import { describe, expect, it } from 'vitest';
import { touchLru } from './workspaces-store';

describe('touchLru', () => {
  it('moves the id to the front and evicts the least recently used', () => {
    expect(touchLru([], 'a', 2)).toEqual(['a']);
    expect(touchLru(['a'], 'b', 2)).toEqual(['b', 'a']);
    expect(touchLru(['b', 'a'], 'c', 2)).toEqual(['c', 'b']);
    expect(touchLru(['c', 'b'], 'b', 2)).toEqual(['b', 'c']);
    expect(touchLru(['a', 'b'], 'c', 0)).toEqual(['c']);
  });
});
