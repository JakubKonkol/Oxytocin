import type { AgentsApi } from '@oxytocin/plugin-api';

export type StateReport = Parameters<AgentsApi['reportState']>[1];

/**
 * The fields of a Claude Code hook input the bridge reads (everything else is ignored). `prompt` (the text of a
 * `UserPromptSubmit`) is only handed to Oxytocin's Code Map lookup, and only when the project turned on "Suggest code
 * locations with each prompt"; it is never stored or logged.
 */
export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  notification_type?: unknown;
  prompt?: unknown;
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

/** The hook output that adds the project's resource brief to Claude's context with the prompt. */
export function briefOutput(text: string) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

/** The most prompt text handed to the Code Map lookup (the core command rejects more). */
export const MAX_PROMPT_CHARS = 4000;
/** How long a prompt-time lookup may take before the prompt goes on without pointers (the hook times out at 5 s). */
export const LOOKUP_BUDGET_MS = 2000;

/** The prompt of a `UserPromptSubmit` input, cut to what the lookup accepts; undefined when there is none. */
export function promptOf(input: HookInput): string | undefined {
  return typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.slice(0, MAX_PROMPT_CHARS) : undefined;
}

/** The text of a lookup that finished within `ms`; null when it failed or took longer (the late answer is dropped). */
export async function within(lookup: Promise<{ text: string } | null | undefined>, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      lookup.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    return result?.text || null;
  } finally {
    clearTimeout(timer);
  }
}

/** One `additionalContext` from the parts that exist (the resource brief, the Code Map pointers). */
export function joinContext(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => !!part).join('\n\n');
}

const MAX_BRIEFED = 1000;

/**
 * Sessions that already got the resource brief: once per session (a new session after /clear gets it again), with
 * the oldest forgotten beyond 1000.
 */
export class BriefedSessions {
  private readonly keys = new Set<string>();

  /** True the first time a session asks. */
  first(terminalId: string, sessionId: string): boolean {
    const key = `${terminalId}:${sessionId}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > MAX_BRIEFED) this.keys.delete(this.keys.values().next().value!);
    return true;
  }

  forget(terminalId: string, sessionId: string): void {
    this.keys.delete(`${terminalId}:${sessionId}`);
  }

  get size(): number {
    return this.keys.size;
  }
}

export interface HookHandlerDeps {
  reportState(terminalId: string, report: StateReport): void;
  /** Runs a core command of Oxytocin (`oxy.commands.execute`). */
  execute(id: string, args: unknown): Promise<unknown>;
  briefed: BriefedSessions;
  /** Test hook: the budget of each lookup in milliseconds. */
  budgetMs?: number;
}

/**
 * What Oxytocin does with a Claude Code hook event: report the agent state, forget a finished session, and answer a
 * prompt with the context to add to it. The resource brief (once per session) and the Code Map pointers (when the
 * project turned them on; Oxytocin decides, the prompt is only read locally for that lookup) share one
 * `additionalContext`. The lookups run together and are bounded, so the prompt never waits for the hook's 5 s limit.
 */
export function createHookHandler(deps: HookHandlerDeps) {
  const budget = deps.budgetMs ?? LOOKUP_BUDGET_MS;
  const ask = (id: string, args: unknown) =>
    within(deps.execute(id, args) as Promise<{ text: string } | null | undefined>, budget);
  return async (terminalId: string, input: HookInput) => {
    const report = stateFromHook(input);
    if (report) deps.reportState(terminalId, report);
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    if (input.hook_event_name === 'SessionEnd' && sessionId) {
      deps.briefed.forget(terminalId, sessionId);
      void deps.execute('oxytocin.codeMap.forgetPromptContext', { terminalId, sessionId }).catch(() => undefined);
    }
    if (input.hook_event_name !== 'UserPromptSubmit' || !sessionId) return undefined;
    const prompt = promptOf(input);
    const [brief, pointers] = await Promise.all([
      deps.briefed.first(terminalId, sessionId) ? ask('oxytocin.resources.agentBrief', { terminalId }) : null,
      prompt ? ask('oxytocin.codeMap.promptContext', { terminalId, sessionId, prompt }) : null,
    ]);
    const text = joinContext(brief, pointers);
    return text ? briefOutput(text) : undefined;
  };
}
