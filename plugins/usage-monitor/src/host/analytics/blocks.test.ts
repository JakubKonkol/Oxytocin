import { describe, expect, it } from 'vitest';
import { activeBlock, BLOCK_MS, computeBlocks } from './blocks';

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);
const ev = (offsetMs: number, cost = 1, tokens = 100) => ({ ts: T0 + offsetMs, costUsd: cost, tokens });

describe('5-hour blocks', () => {
  it('starts a block at the full hour of the first event and keeps events within 5 h in it', () => {
    const blocks = computeBlocks([ev(17 * 60_000), ev(2 * H), ev(4 * H + 59 * 60_000)], T0 + 5 * H - 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      start: T0,
      end: T0 + BLOCK_MS,
      events: 3,
      costUsd: 3,
      tokens: 300,
      active: true,
    });
  });

  it('opens a new block after the previous one ended, at the next event’s full hour', () => {
    const blocks = computeBlocks([ev(10 * 60_000), ev(5 * H + 30 * 60_000), ev(6 * H)], T0 + 7 * H);
    expect(blocks.map((b) => [b.start - T0, b.events, b.active])).toEqual([
      [0, 1, false],
      [5 * H, 2, true],
    ]);
  });

  it('opens a new block after a 5-hour gap and reports no active block afterwards', () => {
    const blocks = computeBlocks([ev(0), ev(12 * H + 5 * 60_000)], T0 + 20 * H);
    expect(blocks.map((b) => b.start - T0)).toEqual([0, 12 * H]);
    expect(activeBlock([ev(0)], T0 + 5 * H)).toBeUndefined();
    expect(activeBlock([ev(0)], T0 + 5 * H - 1)).toMatchObject({ events: 1 });
  });

  it('sorts unsorted input', () => {
    expect(computeBlocks([ev(3 * H), ev(0)], T0)[0]).toMatchObject({ firstEventAt: T0, lastEventAt: T0 + 3 * H });
  });
});
