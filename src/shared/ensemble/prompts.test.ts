import { describe, expect, it } from 'vitest';
import { agentFromPreset, taskFromTemplate } from './presets';
import { systemPromptText } from './prompts';

describe('system prompt', () => {
  it('carries the brief, so an agent knows the task before its first assignment', () => {
    const task = taskFromTemplate('feature', {
      id: 't1',
      projectId: 'p1',
      title: 'CSV export',
      description: 'Export the reports as CSV.',
      now: 0,
    });
    const text = systemPromptText(task, task.agents[0] ?? agentFromPreset('planner', []), { path: '/wt' });
    expect(text).toContain('## The task: CSV export\n\nExport the reports as CSV.');
    expect(text).toContain('Each assignment arrives as a message');
  });
});
