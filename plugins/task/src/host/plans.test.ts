import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureClaudePlan, planReferences, readPlan } from './plans';
import { briefDocument, implementationPrompt, plannerPrompt, reviewPrompt, TaskSchema } from '../shared/task';

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
    // Temp paths can use Windows short names or macOS /var aliases; capture returns the canonical path.
    expect(await captureClaudePlan(home, 'session', 0)).toEqual({
      path: await realpath(path),
      text: '# Approved steps',
    });
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
    const files = { task: '/data/t/task.md', plan: '/data/t/plan.md', brief: '/data/t/brief.md' };
    expect(briefDocument(task)).toBe('# Task\n\nAdd search\n\n# Approved plan\n\nImplement keyboard search\n');
    expect(briefDocument(task)).not.toContain('Later unapproved edit');
    // One line each, so that a new session receives it on its command line.
    expect(implementationPrompt(task, files)).toContain('`/data/t/brief.md`');
    expect(reviewPrompt(task, files)).toContain('Do not edit files');
    for (const prompt of [
      implementationPrompt(task, files),
      reviewPrompt(task, files),
      plannerPrompt(task, files, true),
      plannerPrompt(task, files, false),
    ])
      expect(prompt).not.toMatch(/[\n%!]/);
    expect(plannerPrompt(task, files, true)).toContain('Task: Add search');
    expect(plannerPrompt(task, files, false)).toContain('`/data/t/plan.md`');
    // A long or multi-line description is read from its file.
    expect(plannerPrompt({ ...task, description: 'Line one\nLine two' }, files, true)).toContain(
      'The task is described in `/data/t/task.md`',
    );
    delete task.approvedPlan;
    expect(() => briefDocument(task)).toThrow(/Approve/);
    expect(() => implementationPrompt(task, files)).toThrow(/Approve/);
  });
});
