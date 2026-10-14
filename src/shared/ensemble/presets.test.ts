import { describe, expect, it } from 'vitest';
import { validateTask } from './conductor';
import {
  crewOf,
  crewTask,
  defaultCrew,
  ROLE_PRESETS,
  TASK_TEMPLATES,
  taskFromTemplate,
  titleFromPrompt,
} from './presets';
import { systemPromptText } from './prompts';

const base = { id: 't1', projectId: 'p1', now: 0 };

describe('role presets', () => {
  it('a strong lead and cheaper workers, at the effort the models are tuned for', () => {
    const by = (preset: string) => ROLE_PRESETS.find((p) => p.preset === preset)!;
    expect([by('lead').model, by('lead').effort]).toEqual(['claude-opus-5-5', 'high']);
    expect([by('implementer').model, by('implementer').effort]).toEqual(['claude-sonnet-5-5', 'medium']);
    expect([by('researcher').model, by('researcher').effort]).toEqual(['claude-sonnet-5-5', 'medium']);
    expect(by('docs').model).toBe('claude-haiku-5-5');
    // No preset runs at xhigh or max: those are for work where a gain was measured.
    expect(ROLE_PRESETS.filter((p) => p.effort === 'xhigh' || p.effort === 'max')).toEqual([]);
  });

  it('workers keep their scope, check their work economically and report briefly', () => {
    const implementer = ROLE_PRESETS.find((p) => p.preset === 'implementer')!.rolePrompt;
    expect(implementer).toContain('run a real check that exercises the change');
    expect(implementer).toContain('Do not add features, refactors, files or documentation that were not asked for');
    expect(ROLE_PRESETS.find((p) => p.preset === 'reviewer')!.rolePrompt).toContain('Report every real problem');
    expect(ROLE_PRESETS.find((p) => p.preset === 'researcher')!.rolePrompt).toContain('the answer first');
  });
});

describe('templates', () => {
  it('every template is valid', () => {
    for (const t of TASK_TEMPLATES) expect(validateTask(taskFromTemplate(t.id, base))).toEqual([]);
  });

  it('titles come from the first sentence of the prompt', () => {
    expect(titleFromPrompt('# Export\n\nmore')).toBe('Export');
    expect(titleFromPrompt('Add CSV export. Then more.')).toBe('Add CSV export');
    expect(titleFromPrompt('x'.repeat(80))).toHaveLength(58);
  });
});

describe('lead & crew', () => {
  it('the lead gets the task with its crew, models and efforts, and when (not) to delegate; tests and the approval follow', () => {
    const task = crewTask({
      ...base,
      prompt: 'Add CSV export',
      crew: defaultCrew(),
      testCommand: 'npm test',
      approveResult: true,
    });
    expect(task.agents.map((a) => a.role.label)).toEqual([
      'Lead',
      'Implementer',
      'Reviewer',
      'Researcher',
      'API researcher',
      'Tester',
    ]);
    expect(task.leadId).toBe('barbara');
    expect(task.pipeline.map((s) => [s.kind, s.title])).toEqual([
      ['agent', 'Lead the crew'],
      ['command', 'Run the tests'],
      ['gate', 'Approve the result'],
    ]);
    const lead = task.pipeline[0]!;
    expect(lead).toMatchObject({ kind: 'agent', agentId: 'barbara', output: 'implementation' });
    expect(lead.instruction).toContain('oxy_ensemble_delegate');
    expect(lead.instruction).toContain('- Linus (Implementer) — claude-sonnet-5-5, effort medium · edits files');
    expect(lead.instruction).toContain('- Grace (Reviewer) — claude-sonnet-5-5, effort high · read-only');
    expect(lead.instruction).toContain('At most 4 agents work at the same time');
    // Delegate what is self-contained; keep what needs the lead's context; write a self-contained brief.
    expect(lead.instruction).toContain('Do it yourself:');
    expect(lead.instruction).toContain('Done when: the check that proves it');
    expect(lead.instruction).toContain('same_session: true');
    expect(task.pipeline[1]).toMatchObject({ onFail: { agentId: 'barbara' } });
    expect(task.limits.maxConcurrentAgents).toBe(4);
    expect(task.workspace.mode).toBe('worktree');
    expect(validateTask(task)).toEqual([]);
  });

  it('only the members picked for the task are on it (the lead always); the lead knows only about them', () => {
    const task = crewTask({
      ...base,
      prompt: 'Add CSV export',
      crew: defaultCrew(),
      memberIds: ['linus', 'grace', 'rosalind', 'tim'],
      approveResult: false,
    });
    expect(task.agents.map((a) => a.name)).toEqual(['Barbara', 'Linus', 'Grace', 'Rosalind', 'Tim']);
    expect(task.pipeline[0]!.instruction).not.toContain('Margaret');
    const alone = crewTask({ ...base, prompt: 'x', crew: defaultCrew(), memberIds: [], approveResult: false });
    expect(alone.agents.map((a) => a.name)).toEqual(['Barbara']);
    expect(alone.pipeline[0]!.instruction).toContain('do the work yourself');
    expect(validateTask(alone)).toEqual([]);
  });

  it('crew members get the task as background and do only their part; the lead gets the time signal', () => {
    const task = crewTask({
      ...base,
      prompt: 'Add CSV export to the reports page.',
      crew: defaultCrew(),
      approveResult: false,
    });
    const ws = { path: '/wt', branch: 'ensemble/csv' };
    const linus = systemPromptText(
      task,
      task.agents.find((a) => a.id === 'linus')!,
      ws,
    );
    expect(linus).toContain('Barbara (Lead) leads it');
    expect(linus).toContain('## Background: the whole task (Barbara handles it; you do only the part you are given)');
    expect(linus).not.toContain('oxy_ensemble_delegate');
    expect(linus).toContain('Cite file:line instead of pasting code');
    const barbara = systemPromptText(
      task,
      task.agents.find((a) => a.id === 'barbara')!,
      ws,
    );
    expect(barbara).toContain('oxy_ensemble_delegate');
    expect(barbara).toContain('Time matters here');
    expect(barbara).toContain('## The task: Add CSV export to the reports page');
  });

  it('uses the crew of the setting, falls back to the default and always has a lead', () => {
    const crew = defaultCrew();
    const custom = {
      ...crew,
      leadId: 'linus',
      members: crew.members.map((m) => (m.id === 'linus' ? { ...m, cli: 'codex' as const, model: 'gpt-5.5' } : m)),
    };
    const task = crewTask({ ...base, prompt: 'x', crew: crewOf(custom), approveResult: false });
    expect(task.pipeline).toHaveLength(1);
    expect(task.pipeline[0]).toMatchObject({ agentId: 'linus' });
    expect(task.pipeline[0]!.instruction).toContain('- Barbara (Lead) — claude-opus-5-5');
    expect(crewOf(null).leadId).toBe('barbara');
    expect(crewOf({ leadId: 'x', members: [] }).leadId).toBe('barbara');
    expect(crewOf({ ...crew, leadId: 'gone' }).leadId).toBe('barbara');
  });
});
