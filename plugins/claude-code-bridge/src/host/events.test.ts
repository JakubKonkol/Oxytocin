import { describe, expect, it, vi } from 'vitest';
import {
  BriefedSessions,
  briefOutput,
  createHookHandler,
  joinContext,
  MAX_PROMPT_CHARS,
  promptOf,
  stateFromHook,
  within,
} from './events';

describe('stateFromHook', () => {
  it('maps Claude Code hook events to agent states with the session id', () => {
    const s = { session_id: 'abc' };
    expect(stateFromHook({ ...s, hook_event_name: 'UserPromptSubmit' })).toEqual({
      state: 'working',
      sessionId: 'abc',
    });
    expect(stateFromHook({ ...s, hook_event_name: 'PostToolUse' })).toMatchObject({ state: 'working' });
    expect(stateFromHook({ ...s, hook_event_name: 'PermissionRequest' })).toEqual({
      state: 'waiting',
      waitingFor: 'permission',
      sessionId: 'abc',
    });
    expect(stateFromHook({ ...s, hook_event_name: 'Stop' })).toMatchObject({ state: 'idle' });
    expect(stateFromHook({ ...s, hook_event_name: 'SessionEnd' })).toMatchObject({ state: 'idle' });
  });

  it('distinguishes notification types', () => {
    const n = (notification_type: string) => stateFromHook({ hook_event_name: 'Notification', notification_type });
    expect(n('permission_prompt')).toEqual({ state: 'waiting', waitingFor: 'permission' });
    expect(n('elicitation_dialog')).toEqual({ state: 'waiting', waitingFor: 'input' });
    expect(n('agent_needs_input')).toEqual({ state: 'waiting', waitingFor: 'input' });
    expect(n('idle_prompt')).toEqual({ state: 'idle' });
    expect(n('auth_success')).toBeNull();
  });

  it('ignores unknown events and malformed input', () => {
    expect(stateFromHook({ hook_event_name: 'PreCompact' })).toBeNull();
    expect(stateFromHook({})).toBeNull();
    expect(stateFromHook({ hook_event_name: 'Stop', session_id: 42 })).toEqual({ state: 'idle' });
  });
});

describe('resource brief', () => {
  it('is sent once per session and terminal', () => {
    const b = new BriefedSessions();
    expect(b.first('t1', 's1')).toBe(true);
    expect(b.first('t1', 's1')).toBe(false);
    expect(b.first('t2', 's1')).toBe(true);
    b.forget('t1', 's1');
    expect(b.first('t1', 's1')).toBe(true);
    for (let i = 0; i < 1100; i++) b.first('t', String(i));
    expect(b.size).toBe(1000);
    expect(briefOutput('x')).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' },
    });
  });
});

describe('prompt lookups', () => {
  it('reads a prompt only as text and cuts it to what the Code Map lookup accepts', () => {
    expect(promptOf({ prompt: 'where is the login handler?' })).toBe('where is the login handler?');
    expect(promptOf({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 50) })).toHaveLength(MAX_PROMPT_CHARS);
    expect(promptOf({ prompt: '   ' })).toBeUndefined();
    expect(promptOf({ prompt: 42 })).toBeUndefined();
    expect(promptOf({})).toBeUndefined();
  });

  it('keeps the text of a lookup that is in time and drops failures and late answers', async () => {
    expect(await within(Promise.resolve({ text: 'a' }), 50)).toBe('a');
    expect(await within(Promise.resolve(null), 50)).toBeNull();
    expect(await within(Promise.reject(new Error('boom')), 50)).toBeNull();
    expect(await within(new Promise(() => undefined), 10)).toBeNull();
    expect(await within(new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 60)), 10)).toBeNull();
  });

  it('joins the parts that exist into one context', () => {
    expect(joinContext('brief', null, 'pointers')).toBe('brief\n\npointers');
    expect(joinContext(undefined, 'pointers')).toBe('pointers');
    expect(joinContext(null, '')).toBe('');
  });
});

describe('hook handler', () => {
  const setup = (answers: Record<string, unknown> = {}, budgetMs = 50) => {
    const calls: { id: string; args: unknown }[] = [];
    const reportState = vi.fn();
    const execute = vi.fn((id: string, args: unknown) => {
      calls.push({ id, args });
      const answer = answers[id];
      return typeof answer === 'function' ? (answer as () => Promise<unknown>)() : Promise.resolve(answer ?? null);
    });
    const briefed = new BriefedSessions();
    return {
      calls,
      reportState,
      execute,
      briefed,
      handle: createHookHandler({ reportState, execute, briefed, budgetMs }),
    };
  };
  const prompt = (text: string, session_id = 's1') => ({
    hook_event_name: 'UserPromptSubmit',
    session_id,
    prompt: text,
  });
  const context = (output: unknown) =>
    (output as { hookSpecificOutput: { additionalContext: string } } | undefined)?.hookSpecificOutput.additionalContext;

  it('asks for pointers with the prompt on every prompt and for the brief only on the first', async () => {
    const h = setup({
      'oxytocin.resources.agentBrief': { text: 'BRIEF' },
      'oxytocin.codeMap.promptContext': { text: 'POINTERS' },
    });
    expect(context(await h.handle('t1', prompt('where is the login handler?')))).toBe('BRIEF\n\nPOINTERS');
    expect(context(await h.handle('t1', prompt('and the logout handler?')))).toBe('POINTERS');
    expect(h.calls.filter((c) => c.id === 'oxytocin.resources.agentBrief')).toHaveLength(1);
    expect(h.calls.filter((c) => c.id === 'oxytocin.codeMap.promptContext').map((c) => c.args)).toEqual([
      { terminalId: 't1', sessionId: 's1', prompt: 'where is the login handler?' },
      { terminalId: 't1', sessionId: 's1', prompt: 'and the logout handler?' },
    ]);
    expect(h.reportState).toHaveBeenCalledWith('t1', { state: 'working', sessionId: 's1' });
  });

  it('answers with only what exists, or with nothing (204)', async () => {
    const onlyBrief = setup({ 'oxytocin.resources.agentBrief': { text: 'BRIEF' } });
    expect(context(await onlyBrief.handle('t1', prompt('where is the login handler?')))).toBe('BRIEF');
    const onlyPointers = setup({ 'oxytocin.codeMap.promptContext': { text: 'POINTERS' } });
    expect(context(await onlyPointers.handle('t1', prompt('where is the login handler?')))).toBe('POINTERS');
    const nothing = setup();
    expect(await nothing.handle('t1', prompt('where is the login handler?'))).toBeUndefined();
  });

  it('skips the pointer lookup without a prompt text or a session, and for other events', async () => {
    const h = setup();
    await h.handle('t1', { hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    await h.handle('t1', { hook_event_name: 'UserPromptSubmit', prompt: 'where is the login handler?' });
    await h.handle('t1', { hook_event_name: 'PostToolUse', session_id: 's1', prompt: 'where is the login handler?' });
    expect(h.calls.filter((c) => c.id === 'oxytocin.codeMap.promptContext')).toEqual([]);
  });

  it('still answers within the budget when Oxytocin is slow or fails; the brief is not lost to a slow lookup', async () => {
    const slow = setup({
      'oxytocin.resources.agentBrief': { text: 'BRIEF' },
      'oxytocin.codeMap.promptContext': () => new Promise(() => undefined),
    });
    const started = Date.now();
    expect(context(await slow.handle('t1', prompt('where is the login handler?')))).toBe('BRIEF');
    expect(Date.now() - started).toBeLessThan(1000);
    const failing = setup({
      'oxytocin.codeMap.promptContext': () => Promise.reject(new Error('Invalid arguments')),
    });
    expect(await failing.handle('t1', prompt('where is the login handler?'))).toBeUndefined();
  });

  it('forgets the brief and the suggested pointers of a session when it ends', async () => {
    const h = setup({ 'oxytocin.resources.agentBrief': { text: 'BRIEF' } });
    await h.handle('t1', prompt('where is the login handler?'));
    expect(h.briefed.size).toBe(1);
    await h.handle('t1', { hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(h.briefed.size).toBe(0);
    expect(h.calls.at(-1)).toEqual({
      id: 'oxytocin.codeMap.forgetPromptContext',
      args: { terminalId: 't1', sessionId: 's1' },
    });
    expect(context(await h.handle('t1', prompt('where is the login handler?')))).toBe('BRIEF');
  });
});
