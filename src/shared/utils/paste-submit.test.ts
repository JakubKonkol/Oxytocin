import { describe, expect, it } from 'vitest';
import { pasteSubmitDeadlineMs, pasteSubmitDue } from './paste-submit';

describe('pasteSubmitDue', () => {
  const due = (o: { now: number; lastOutputAt: number; length?: number }) =>
    pasteSubmitDue({ writtenAt: 1000, length: 300, ...o });

  it('waits until the program drew the paste and stayed quiet', () => {
    // Nothing drawn yet (Codex CLI on Windows still reads the paste key by key).
    expect(due({ now: 1500, lastOutputAt: 900 })).toBe(false);
    // Drawn, but not quiet for long enough.
    expect(due({ now: 1500, lastOutputAt: 1400 })).toBe(false);
    expect(due({ now: 1700, lastOutputAt: 1400 })).toBe(true);
  });

  it('keeps the shortest pause even when the program is quiet at once', () => {
    expect(pasteSubmitDue({ writtenAt: 1000, length: 10, now: 1100, lastOutputAt: 1001, minDelayMs: 150 })).toBe(false);
  });

  it('presses Enter after a deadline that grows with the length when nothing is drawn', () => {
    expect(pasteSubmitDeadlineMs(300)).toBe(1650);
    expect(pasteSubmitDeadlineMs(60_000)).toBe(31_500);
    expect(pasteSubmitDeadlineMs(1_000_000)).toBe(60_000);
    expect(due({ now: 1000 + 1649, lastOutputAt: 0 })).toBe(false);
    expect(due({ now: 1000 + 1650, lastOutputAt: 0 })).toBe(true);
  });
});
