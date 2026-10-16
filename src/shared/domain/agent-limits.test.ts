import { describe, expect, it } from 'vitest';
import { type AgentLimitWindow, blockingWindow, currentUsage } from './agent-limits';

const w = (window: string, usedPercent: number, windowMinutes: number | null, resetsAt: number | null = null) =>
  ({ window, usedPercent, windowMinutes, resetsAt, observedAt: 1 }) satisfies AgentLimitWindow;

describe('agent limits', () => {
  it('counts a window whose reset time passed as empty', () => {
    expect(currentUsage(w('five_hour', 80, 300, 1000), 999)).toBe(80);
    expect(currentUsage(w('five_hour', 80, 300, 1000), 1000)).toBe(0);
    expect(currentUsage(w('five_hour', 80, 300, null), 5000)).toBe(80);
  });

  it('picks the fuller time-based window (the one that stops the account first)', () => {
    expect(blockingWindow(undefined, 0)).toBeNull();
    expect(blockingWindow({ windows: [w('spend_limit', 99, null)] }, 0)).toBeNull();
    const five = w('five_hour', 40, 300, 10_000);
    const week = w('seven_day', 92, 10080, 99_000);
    expect(blockingWindow({ windows: [five, week] }, 0)).toMatchObject({ window: 'seven_day', current: 92 });
    // Equal usage: the shorter window.
    expect(blockingWindow({ windows: [w('seven_day', 50, 10080), w('five_hour', 50, 300)] }, 0)).toMatchObject({
      window: 'five_hour',
    });
    // The 5-hour window started over: 0, and the weekly one counts.
    expect(blockingWindow({ windows: [w('five_hour', 99, 300, 5), w('seven_day', 10, 10080)] }, 6)).toMatchObject({
      window: 'seven_day',
      current: 10,
    });
  });
});
