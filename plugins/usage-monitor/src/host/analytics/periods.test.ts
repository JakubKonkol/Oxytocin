import { describe, expect, it } from 'vitest';
import { periodKey, periodRange, startOfWeek } from './periods';

describe('local periods', () => {
  const ts = new Date(2026, 8, 26, 15, 30).getTime(); // Saturday 26 Sep 2026, local time
  it('computes day, week and month ranges', () => {
    expect(periodRange('day', ts)).toEqual({
      from: new Date(2026, 8, 26).getTime(),
      to: new Date(2026, 8, 27).getTime(),
    });
    expect(periodRange('week', ts, 'monday').from).toBe(new Date(2026, 8, 21).getTime());
    expect(startOfWeek(ts, 'sunday')).toBe(new Date(2026, 8, 20).getTime());
    expect(periodRange('month', ts)).toEqual({
      from: new Date(2026, 8, 1).getTime(),
      to: new Date(2026, 9, 1).getTime(),
    });
  });
  it('builds stable keys', () => {
    expect(periodKey('day', periodRange('day', ts).from)).toBe('day:2026-09-26');
    expect(periodKey('month', periodRange('month', ts).from)).toBe('month:2026-09');
    expect(periodKey('block5h', new Date(2026, 8, 26, 14).getTime())).toBe('block5h:2026-09-26T14');
  });
});
