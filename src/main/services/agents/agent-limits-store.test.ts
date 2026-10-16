import { describe, expect, it } from 'vitest';
import { AgentLimitsStore } from './agent-limits-store';

const window = (usedPercent: number, observedAt: number) => ({
  window: 'five_hour',
  usedPercent,
  windowMinutes: 300,
  resetsAt: null,
  observedAt,
});

describe('AgentLimitsStore', () => {
  it('keeps the newest reading of each window per account and fires on changes only', () => {
    const store = new AgentLimitsStore();
    const events: number[] = [];
    store.onDidChange((l) => events.push(l.length));
    store.report({ agent: 'claude', accountId: 'main', windows: [window(20, 10)] });
    store.report({ agent: 'claude', accountId: 'main', windows: [window(20, 10)] });
    store.report({ agent: 'claude', accountId: 'main', windows: [window(5, 5)] });
    store.report({ agent: 'codex', accountId: 'acc_1', windows: [window(70, 3)] });
    expect(events).toEqual([1, 2]);
    expect(store.list().find((l) => l.agent === 'claude')?.windows[0]?.usedPercent).toBe(20);
    store.report({ agent: 'claude', accountId: 'main', windows: [{ ...window(30, 11), window: 'seven_day' }] });
    expect(
      store
        .list()
        .find((l) => l.agent === 'claude')
        ?.windows.map((w) => w.window),
    ).toEqual(['five_hour', 'seven_day']);
    expect(() => store.report({ agent: 'claude', accountId: 'main', windows: [{ window: 'x' }] })).toThrow(/Invalid/);
    store.retain(new Set(['claude/main']));
    expect(store.list().map((l) => l.agent)).toEqual(['claude']);
  });
});
