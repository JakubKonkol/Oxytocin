import { describe, expect, it, vi } from 'vitest';
import { absoluteRulePath, decision, HOOK_PATH, PlanHookServer, plannerSettings, taskFolderSettings } from './hook';

describe('planner settings', () => {
  it('spells project paths as absolute permission rule paths', () => {
    expect(absoluteRulePath('C:\\Users\\Jane Doe\\repo\\')).toBe('//c/Users/Jane Doe/repo');
    expect(absoluteRulePath('/home/jane/repo')).toBe('//home/jane/repo');
  });

  it("lets Claude read Task's folder, and a planner without the hook write its plan there", () => {
    expect(taskFolderSettings('C:\\Users\\Jane Doe\\task')).toEqual({
      permissions: { allow: ['Read(//c/Users/Jane Doe/task/**)'] },
    });
    expect(taskFolderSettings('/data/task', true).permissions.allow).toEqual([
      'Read(//data/task/**)',
      'Edit(//data/task/**)',
    ]);
  });

  it('denies edits in the project and history-changing git commands, and hooks ExitPlanMode only', () => {
    const settings = plannerSettings({
      projectRoot: 'D:\\work\\app',
      taskDir: 'D:\\data\\task',
      url: 'http://127.0.0.1:1/task/exit-plan',
      token: 'x',
    });
    expect(settings.permissions.allow).toEqual(['Read(//d/data/task/**)']);
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
            timeout: 345600,
            headers: { Authorization: 'Bearer x', 'X-Oxytocin-Task': '$OXYTOCIN_TASK_ID' },
            allowedEnvVars: ['OXYTOCIN_TASK_ID'],
          },
        ],
      },
    ]);
  });
});

describe('plan hook server', () => {
  const post = (port: number, token: string) =>
    fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-oxytocin-task': 'task-1' },
      body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '# P' } }),
    });

  it('keeps a long decision alive with whitespace before the JSON answer', async () => {
    let decide: (output: object | undefined) => void = () => {};
    const server = new PlanHookServer('secret', () => new Promise((resolve) => (decide = resolve)), {
      afterMs: 20,
      everyMs: 20,
    });
    const port = await server.start(0);
    try {
      const res = await post(port, 'secret');
      // The headers arrived before the decision.
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 80));
      decide(decision('Approved'));
      const text = await res.text();
      expect(text).toMatch(/^ {2,}\{/);
      expect(JSON.parse(text)).toEqual(decision('Approved'));
      // No decision after the headers: a blank body.
      const blank = post(port, 'secret');
      await new Promise((r) => setTimeout(r, 50));
      decide(undefined);
      expect((await (await blank).text()).trim()).toBe('');
    } finally {
      await server.stop();
    }
  });

  it('answers a quick decision directly and tells the handler when Claude Code stops waiting', async () => {
    let closed: AbortSignal | undefined;
    const server = new PlanHookServer('secret', (_id, _input, signal) => {
      closed = signal;
      return new Promise(() => {});
    });
    const port = await server.start(0);
    try {
      const esc = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'x-oxytocin-task': 'task-1' },
        body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '# P' } }),
        signal: esc.signal,
      }).catch(() => null);
      await vi.waitFor(() => expect(closed).toBeDefined());
      esc.abort();
      await request;
      await vi.waitFor(() => expect(closed!.aborted).toBe(true));
    } finally {
      await server.stop();
    }
    const quick = new PlanHookServer('secret', () => Promise.resolve(decision('Rejected')));
    const port2 = await quick.start(0);
    try {
      const res = await post(port2, 'secret');
      expect(res.headers.get('content-length')).not.toBeNull();
      expect(await res.json()).toEqual(decision('Rejected'));
    } finally {
      await quick.stop();
    }
  });
});
