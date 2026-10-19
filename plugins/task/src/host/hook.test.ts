import { describe, expect, it } from 'vitest';
import { absoluteRulePath, plannerSettings } from './hook';

describe('planner settings', () => {
  it('spells project paths as absolute permission rule paths', () => {
    expect(absoluteRulePath('C:\\Users\\Jane Doe\\repo\\')).toBe('//c/Users/Jane Doe/repo');
    expect(absoluteRulePath('/home/jane/repo')).toBe('//home/jane/repo');
  });

  it('denies edits in the project and history-changing git commands, and hooks ExitPlanMode only', () => {
    const settings = plannerSettings({
      projectRoot: 'D:\\work\\app',
      url: 'http://127.0.0.1:1/task/exit-plan',
      token: 'x',
    });
    expect(settings.permissions.deny).toEqual([
      'Edit(//d/work/app/**)',
      'Bash(git commit *)',
      'Bash(git push *)',
      'Bash(git checkout *)',
      'Bash(git reset *)',
    ]);
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'ExitPlanMode',
        hooks: [
          {
            type: 'http',
            url: 'http://127.0.0.1:1/task/exit-plan',
            timeout: 10,
            headers: { Authorization: 'Bearer x', 'X-Oxytocin-Task': '$OXYTOCIN_TASK_ID' },
            allowedEnvVars: ['OXYTOCIN_TASK_ID'],
          },
        ],
      },
    ]);
  });
});
