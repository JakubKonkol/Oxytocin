import type { AgentsApi } from '@oxytocin/plugin-api';

export type StateReport = Parameters<AgentsApi['reportState']>[1];

/** The fields of a Claude Code hook input the bridge reads (everything else, e.g. prompts, is ignored). */
export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  notification_type?: unknown;
}

/** Claude Code hook events the bridge subscribes to (only `command`-less events that support `http` hooks). */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

const WAITING_NOTIFICATIONS: Record<string, string> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'input',
  elicitation_url_dialog: 'input',
  agent_needs_input: 'input',
};

/** Maps a hook input to the agent state it implies (null = no state change). */
export function stateFromHook(input: HookInput): StateReport | null {
  const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined;
  const withSession = (report: StateReport): StateReport => (sessionId ? { ...report, sessionId } : report);
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return withSession({ state: 'working' });
    case 'PermissionRequest':
      return withSession({ state: 'waiting', waitingFor: 'permission' });
    case 'Notification': {
      const type = typeof input.notification_type === 'string' ? input.notification_type : '';
      const waitingFor = WAITING_NOTIFICATIONS[type];
      if (waitingFor) return withSession({ state: 'waiting', waitingFor });
      return type === 'idle_prompt' ? withSession({ state: 'idle' }) : null;
    }
    case 'Stop':
    case 'SessionEnd':
      return withSession({ state: 'idle' });
    default:
      return null;
  }
}
