import { describe, expect, it } from 'vitest';
import { fitMenu } from './view-context-menu';

const viewport = { width: 1280, height: 800 };
const size = { width: 180, height: 120 };

describe('fitMenu', () => {
  it('opens at the pointer when the menu fits', () => {
    expect(fitMenu({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('opens to the left of / above the pointer near the right and bottom edges', () => {
    // "More actions" of a Run view in the right sidebar.
    expect(fitMenu({ x: 1260, y: 90 }, size, viewport)).toEqual({ x: 1080, y: 90 });
    expect(fitMenu({ x: 300, y: 760 }, size, viewport)).toEqual({ x: 300, y: 640 });
  });

  it('stays inside a window smaller than the menu would need', () => {
    expect(fitMenu({ x: 50, y: 50 }, { width: 400, height: 300 }, { width: 300, height: 200 })).toEqual({
      x: 4,
      y: 4,
    });
    expect(fitMenu({ x: 150, y: 150 }, { width: 180, height: 120 }, { width: 300, height: 200 })).toEqual({
      x: 4,
      y: 30,
    });
  });
});
