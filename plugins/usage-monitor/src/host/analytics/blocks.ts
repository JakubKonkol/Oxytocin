/** Claude subscription usage blocks (as in ccusage). */
export const BLOCK_MS = 5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface BlockEvent {
  ts: number;
  costUsd: number;
  tokens: number;
}

export interface UsageBlock {
  start: number;
  end: number;
  firstEventAt: number;
  lastEventAt: number;
  costUsd: number;
  tokens: number;
  events: number;
  active: boolean;
}

/** Local full hour of a timestamp (ccusage floors to the hour in UTC; local and UTC hours coincide for whole-hour zones). */
function floorToHour(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

/**
 * Groups events (sorted or not) into 5-hour blocks: a block starts at the full hour of the first event after the
 * previous block ended (or after a gap of 5 h) and lasts 5 h. The block is active while `now` is inside it.
 */
export function computeBlocks(events: BlockEvent[], now: number): UsageBlock[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const blocks: UsageBlock[] = [];
  let current: UsageBlock | undefined;
  for (const e of sorted) {
    if (!current || e.ts >= current.end || e.ts - current.lastEventAt >= BLOCK_MS) {
      const start = floorToHour(e.ts);
      current = {
        start,
        end: start + BLOCK_MS,
        firstEventAt: e.ts,
        lastEventAt: e.ts,
        costUsd: 0,
        tokens: 0,
        events: 0,
        active: false,
      };
      blocks.push(current);
    }
    current.lastEventAt = e.ts;
    current.costUsd += e.costUsd;
    current.tokens += e.tokens;
    current.events++;
  }
  for (const b of blocks) b.active = now >= b.start && now < b.end;
  return blocks;
}

export function activeBlock(events: BlockEvent[], now: number): UsageBlock | undefined {
  return computeBlocks(events, now).find((b) => b.active);
}
