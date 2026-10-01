import { describe, expect, it } from 'vitest';
import type { AgentLive } from '@shared/domain/ensemble';
import { deliver } from './prompt-delivery';

function fake(o: { precise: boolean; reactAfterPaste?: boolean; reactAfterEnter?: boolean; initial?: AgentLive }) {
  let t = 0;
  let state: AgentLive = o.initial ?? 'idle';
  let lastWorkingAt = -1;
  let lastOutputAt = 0;
  const calls: string[] = [];
  const react = () => {
    state = 'working';
    lastWorkingAt = t;
    lastOutputAt = t + 1000;
  };
  return {
    calls,
    deps: {
      precise: o.precise,
      state: () => state,
      lastOutputAt: () => lastOutputAt,
      lastWorkingAt: () => lastWorkingAt,
      paste: (text: string) => {
        calls.push(`paste:${text}`);
        if (o.reactAfterPaste) react();
        return Promise.resolve();
      },
      enter: () => {
        calls.push('enter');
        if (o.reactAfterEnter) react();
        return Promise.resolve();
      },
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    },
  };
}

describe('deliver', () => {
  it('pastes once when the agent starts working', async () => {
    const f = fake({ precise: true, reactAfterPaste: true });
    expect(await deliver('[Ensemble] go', f.deps)).toEqual({ ok: true });
    expect(f.calls).toEqual(['paste:[Ensemble] go']);
  });

  it('sends Enter once more when the agent did not start, then succeeds', async () => {
    const f = fake({ precise: true, reactAfterEnter: true });
    expect(await deliver('[Ensemble] go', f.deps)).toEqual({ ok: true });
    expect(f.calls).toEqual(['paste:[Ensemble] go', 'enter']);
  });

  it('fails after the retry', async () => {
    const f = fake({ precise: true });
    expect(await deliver('[Ensemble] go', f.deps)).toMatchObject({ ok: false });
    expect(f.calls).toEqual(['paste:[Ensemble] go', 'enter']);
  });

  it('never types while the agent is working or waiting, and never a slash command', async () => {
    for (const initial of ['working', 'waiting', 'starting'] as const) {
      const f = fake({ precise: true, initial });
      expect(await deliver('[Ensemble] go', f.deps)).toMatchObject({ ok: false });
      expect(f.calls).toEqual([]);
    }
    const f = fake({ precise: true });
    expect(await deliver('/model opus', f.deps)).toMatchObject({ ok: false, error: /slash commands/ });
    expect(f.calls).toEqual([]);
  });

  it('heuristic agents count new output as having started', async () => {
    const f = fake({ precise: false, reactAfterPaste: true });
    expect(await deliver('[Ensemble] go', f.deps)).toEqual({ ok: true });
  });
});
