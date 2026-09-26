import { describe, expect, it } from 'vitest';
import { resolveWindowBounds } from './ui-state-service';

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };

describe('resolveWindowBounds', () => {
  it('keeps bounds that are visible on a display', () => {
    const state = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };
    expect(resolveWindowBounds(state, [primary, secondary], primary)).toEqual({
      x: 2000,
      y: 100,
      width: 1200,
      height: 800,
    });
  });

  it('centers on the primary display when the saved display is gone', () => {
    const state = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };
    expect(resolveWindowBounds(state, [primary], primary)).toEqual({ x: 360, y: 120, width: 1200, height: 800 });
  });

  it('omits the position when none was saved and clamps the size', () => {
    expect(resolveWindowBounds({ width: 4000, height: 3000, maximized: false }, [primary], primary)).toEqual({
      width: 1920,
      height: 1040,
    });
  });
});
