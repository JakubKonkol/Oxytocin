import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureClaudePlan, planReferences, readPlan } from './plans';
import { implementationPrompt, reviewPrompt, TaskSchema } from '../shared/task';

describe('Task plans', () => {
  it('extracts document references without copying the conversation or tool results', () => {
    expect(
      planReferences(
        'partial\n' +
          JSON.stringify({
            slug: 'gentle-plan',
            message: {
              content: [
                { type: 'text', text: 'private conversation' },
                {
                  type: 'tool_use',
                  name: 'Write',
                  input: { file_path: '/h/plans/gentle-plan.md', content: 'private' },
                },
              ],
            },
          }),
      ),
    ).toEqual({ slug: 'gentle-plan', paths: ['/h/plans/gentle-plan.md'] });
  });
  it('captures only the selected session’s new plan and refuses references outside its plan folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oxy-task-plan-'));
    await mkdir(join(home, 'projects', '-repo'), { recursive: true });
    await mkdir(join(home, 'plans'));
    const path = join(home, 'plans', 'gentle-plan.md');
    const outside = join(home, 'private.md');
    await writeFile(outside, 'Never forward this');
    await writeFile(path, '# Approved steps');
    await writeFile(
      join(home, 'projects', '-repo', 'session.jsonl'),
      JSON.stringify({
        slug: 'gentle-plan',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: outside } }] },
      }),
    );
    expect(await captureClaudePlan(home, 'session', 0)).toEqual({ path, text: '# Approved steps' });
    expect(await captureClaudePlan(home, '../session', 0)).toBeNull();
    expect(await captureClaudePlan(home, 'other-session', 0)).toBeNull();
    await utimes(path, 1, 1);
    expect(await captureClaudePlan(home, 'session', Date.now())).toBeNull();
    expect(await readPlan(path, Date.now())).toBeNull();
  });
  it('forwards only the frozen approved plan and task, never later planner edits', () => {
    const task = TaskSchema.parse({
      id: 'ef6c58c7-c80e-4c18-b389-9f72e67d6bce',
      projectId: 'p',
      description: 'Add search',
      planner: { launchId: 'ai:claude' },
      implementer: { launchId: 'ai:codex' },
      phase: 'implementing',
      startedAt: 1,
      updatedAt: 1,
      plan: 'Later unapproved edit',
      approvedPlan: 'Implement keyboard search',
    });
    expect(implementationPrompt(task)).toContain('Implement keyboard search');
    expect(implementationPrompt(task)).not.toContain('Later unapproved edit');
    expect(reviewPrompt(task)).toContain('Do not edit files');
    delete task.approvedPlan;
    expect(() => implementationPrompt(task)).toThrow(/Approve/);
  });
});
