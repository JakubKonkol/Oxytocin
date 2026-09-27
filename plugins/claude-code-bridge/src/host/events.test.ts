import { describe, expect, it } from 'vitest';
import { stateFromHook } from './events';

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
