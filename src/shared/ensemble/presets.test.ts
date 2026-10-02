import { describe, expect, it } from 'vitest';
import { validateTask } from './conductor';
import { quickTask, titleFromPrompt } from './presets';

const base = { id: 't1', projectId: 'p1', now: 0 };

describe('quick start', () => {
  it('planner, API researcher and implementer: the planner leads and delegates, you approve, the implementer builds', () => {
    const task = quickTask({
      ...base,
      prompt: 'Show the weather from api.example.com on the dashboard.\nUse the existing card component.',
      team: { roles: ['implementer', 'api-researcher'], approvePlan: true },
    });
    expect(task.title).toBe('Show the weather from api.example.com on the dashboard');
    expect(task.description).toContain('Use the existing card component.');
    expect(task.agents.map((a) => a.role.label)).toEqual(['Planner', 'Implementer', 'API researcher']);
    expect(task.pipeline.map((s) => [s.kind, s.title])).toEqual([
      ['agent', 'Plan (with research)'],
      ['gate', 'Approve the plan'],
      ['agent', 'Implement'],
    ]);
    const plan = task.pipeline[0]!;
    expect(plan.instruction).toContain('oxy_ensemble_delegate');
    expect(plan.instruction).toContain('Tim (API researcher): maps the endpoints and their shapes');
    expect(plan.instruction).toContain('Write it for Linus (Implementer)');
    expect(task.workspace.mode).toBe('worktree');
    expect(validateTask(task)).toEqual([]);
  });

  it('a reviewer makes a review loop; a tester and a test command follow; no gate when not wanted', () => {
    const task = quickTask({
      ...base,
      prompt: 'Fix the login bug',
      team: { roles: ['tester', 'reviewer', 'implementer'], approvePlan: false, testCommand: 'npm test' },
    });
    expect(task.pipeline.map((s) => s.kind)).toEqual(['agent', 'loop', 'agent', 'command']);
    expect(task.pipeline[0]!.instruction).not.toContain('oxy_ensemble_delegate');
    expect(validateTask(task)).toEqual([]);
  });

  it('a read-only team works in the current checkout', () => {
    const task = quickTask({
      ...base,
      prompt: 'How does auth work?',
      team: { roles: ['researcher'], approvePlan: false },
    });
    expect(task.workspace.mode).toBe('current-checkout');
    expect(validateTask(task)).toEqual([]);
  });

  it('titles come from the first sentence of the prompt', () => {
    expect(titleFromPrompt('# Export\n\nmore')).toBe('Export');
    expect(titleFromPrompt('Add CSV export. Then more.')).toBe('Add CSV export');
    expect(titleFromPrompt('x'.repeat(80))).toHaveLength(58);
  });
});
