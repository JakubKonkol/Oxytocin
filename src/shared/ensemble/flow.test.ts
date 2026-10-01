import { describe, expect, it } from 'vitest';
import type { EnsembleRun, EnsembleTask } from '../domain/ensemble';
import { initialRun, reduce } from './conductor';
import { formatCost, formatDuration, formatTokens, stepper, timeline, whoSeesWhat } from './flow';
import { taskFromTemplate } from './presets';

function feature(): { task: EnsembleTask; run: EnsembleRun } {
  const task = taskFromTemplate('feature', { id: 't', projectId: 'p', now: 0 });
  return { task, run: initialRun(task) };
}

describe('flow derivations', () => {
  it('derives the stepper from the stage states', () => {
    const { task } = feature();
    let run = initialRun(task);
    const step = (event: Parameters<typeof reduce>[2], now: number) => (run = reduce(task, run, event, now).run);
    step({ type: 'start' }, 1);
    step({ type: 'workspace-ready', worktree: { mode: 'worktree', path: '/w', baseCommit: 'abc' } }, 2);
    const items = stepper(task, run);
    expect(items.map((i) => [i.title, i.status, i.current])).toEqual([
      ['Plan', 'running', true],
      ['Approve the plan', 'pending', false],
      ['Implement ⇄ Review', 'pending', false],
      ['Tests', 'pending', false],
      ['Approve the result', 'pending', false],
    ]);
  });

  it('builds swimlanes with state segments, markers and stage bands', () => {
    const { task } = feature();
    let run = initialRun(task);
    const planner = task.agents[0]!.id;
    const step = (event: Parameters<typeof reduce>[2], now: number) => (run = reduce(task, run, event, now).run);
    step({ type: 'start' }, 1000);
    step({ type: 'workspace-ready', worktree: { mode: 'worktree', path: '/w', baseCommit: 'abc' } }, 1000);
    step({ type: 'agent-started', agentId: planner, terminalId: 't1' }, 1500);
    step({ type: 'agent-state', agentId: planner, state: 'idle' }, 2000);
    step({ type: 'agent-state', agentId: planner, state: 'working' }, 3000);
    step({ type: 'submit', agentId: planner, submission: { kind: 'plan', summary: 'plan' } }, 9000);
    step({ type: 'agent-state', agentId: planner, state: 'idle' }, 9500);
    const model = timeline(task, run, 10_000);
    const lane = model.lanes.find((l) => l.id === planner)!;
    expect(lane.segments.map((s) => [s.state, s.from, s.to])).toEqual([
      ['starting', 1000, 2000],
      ['idle', 2000, 3000],
      ['working', 3000, 9500],
      ['idle', 9500, 10_000],
    ]);
    expect(lane.markers.map((m) => m.kind)).toEqual(['handoff']);
    expect(model.lanes[0]!.markers.some((m) => m.kind === 'decision')).toBe(true);
    expect(model.bands.map((b) => b.title)).toEqual(['Plan', 'Approve the plan']);
  });

  it('who sees what counts the context each agent was served', () => {
    const { task } = feature();
    let run = initialRun(task);
    run = reduce(
      task,
      run,
      { type: 'context-served', agentId: task.agents[1]!.id, items: ['assignment: Implement', 'plan', 'brief'] },
      1,
    ).run;
    const rows = whoSeesWhat(task, run);
    expect(rows[0]).toMatchObject({ id: 'conductor', caption: 'every event' });
    expect(rows.find((r) => r.id === task.agents[1]!.id)).toMatchObject({ count: 1, caption: 'plan + brief' });
    expect(rows.find((r) => r.id === task.agents[0]!.id)).toMatchObject({ count: 0, caption: 'nothing yet' });
  });

  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(12.3)).toBe('$12.30');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(35_400)).toBe('35k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});
