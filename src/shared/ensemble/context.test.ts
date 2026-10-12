import { describe, expect, it } from 'vitest';
import { initialRun } from './conductor';
import { agentContext, assignmentDigest, MAX_CONTEXT } from './context';
import { crewTask, defaultCrew } from './presets';

const task = crewTask({
  id: 't1',
  projectId: 'p1',
  prompt: 'Add CSV export.\nUse semicolons as separators.',
  crew: defaultCrew(),
  approveResult: false,
  now: 0,
});

function runWithResults(n: number, size: number) {
  const run = initialRun(task);
  const agents = ['linus', 'grace', 'rosalind', 'tim', 'margaret'];
  for (let i = 0; i < n; i++)
    run.handoffs.push({
      id: `h-${i}`,
      stageId: 'lead',
      agentId: agents[i % agents.length]!,
      kind: i % 2 ? 'research' : 'review',
      summary: `result ${i}`,
      body: 'x'.repeat(size),
      at: i,
      by: 'agent',
    });
  return run;
}

describe('agent context', () => {
  it('oxy_ensemble_context stays bounded however many results there are', () => {
    const c = agentContext(task, runWithResults(40, 50_000), 'barbara', { includeRole: false });
    expect(c.text.length).toBeLessThan(MAX_CONTEXT + 200);
    // Each result is shortened, not repeated in full.
    expect(c.text).not.toContain('x'.repeat(7_000));
  });

  it('the brief appears once when the role text is included', () => {
    const c = agentContext(task, initialRun(task), 'barbara', { includeRole: true });
    expect(c.text.split('Use semicolons as separators.')).toHaveLength(2);
  });

  it('an assignment digest skips what was seen and what the instruction covers', () => {
    const run = runWithResults(3, 100);
    const d = assignmentDigest(task, run, 'barbara', {
      includeRole: false,
      seen: new Set(['h-0']),
      covered: new Set(['h-1']),
    });
    expect(d.text).not.toContain('result 0');
    expect(d.text).not.toContain('result 1');
    expect(d.text).toContain('result 2');
    expect(d.shown).toEqual(['h-1', 'h-2']);
  });
});
