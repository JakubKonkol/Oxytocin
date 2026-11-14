import {
  AI_ACCOUNT_AGENTS,
  AI_AGENT_CATALOG,
  type AiAccountAgent,
  accountLabel,
  type AgentAccount,
  type AiAgentsState,
  type AiProfile,
  agentName,
  type DetectedAiAgent,
  presetOf,
} from '@shared/domain/ai-agents';
import type { SecretChange } from '@shared/domain/project-resources';

/** An entry of the "+" menu's AI agents section. */
export interface AiMenuEntry {
  /** The terminal profile id that starts it (`ai:claude`, `ai:profile:<id>`, `ai:account:<id>`). */
  launchId: string;
  name: string;
  /** The account ("you@example.com") or the API of a profile. */
  detail?: string;
  kind: 'agent' | 'profile' | 'account';
}

/** "Claude Code · Work". */
export const accountTitle = (a: Pick<AgentAccount, 'agent' | 'name'>): string => `${agentName(a.agent)} · ${a.name}`;

/** Who an added account is signed in with, or that it is not yet. */
export function accountLoginText(state: AiAgentsState, id: string): string {
  const logins = state.accountsInfo.logins[id] ?? [];
  return accountLabel({ accounts: logins }) ?? 'not signed in';
}

/** Detected agents (not local runtimes), added accounts and profiles, minus the ones hidden from the "+" menu. */
export { agentLaunchers as menuEntries } from '@shared/domain/agent-launch';

/** "GLM (Z.ai) · glm-4.6". */
export function profileDetail(p: AiProfile): string {
  const provider = presetOf(p.provider).label;
  return p.model ? `${provider} · ${p.model}` : provider;
}

/** Shows or hides an entry of the "+" menu. */
export function withHidden(hidden: readonly string[], launchId: string, show: boolean): string[] {
  const rest = hidden.filter((h) => h !== launchId);
  return show ? rest : [...rest, launchId];
}

/** API key changes to save, for profiles that still exist. */
export function profileSecretChanges(
  profiles: readonly AiProfile[],
  keys: Record<string, { value: string } | { remove: true }>,
): SecretChange[] {
  const ids = new Set(profiles.map((p) => p.id));
  return Object.entries(keys)
    .filter(([id]) => ids.has(id))
    .flatMap(([id, edit]): SecretChange[] => {
      if ('remove' in edit) return [{ resourceId: id, key: 'apiKey', value: null }];
      return edit.value ? [{ resourceId: id, key: 'apiKey', value: edit.value }] : [];
    });
}

/** "2 minutes ago", "just now". */
export function agoText(at: number | null, now = Date.now()): string {
  if (at === null) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * The agents whose accounts Settings lists: the ones installed (not removed from Oxytocin) and any with added
 * accounts. An agent that is not used has no card to look past.
 */
export function accountAgentsShown(state: AiAgentsState): AiAccountAgent[] {
  return AI_ACCOUNT_AGENTS.filter(
    (agent) => state.agents.some((a) => a.id === agent) || state.accounts.some((a) => a.agent === agent),
  );
}

/** Whether the main account's sign-in lives in the agent's own files (and can be signed out from Oxytocin). */
export function canSignOut(agent: DetectedAiAgent | undefined): boolean {
  return !!agent?.accounts.some(
    (a) => a.method === 'oauth' || (a.method === 'api-key' && a.detail === 'Codex auth.json'),
  );
}

/** Agents removed from Oxytocin that can be brought back, by name. */
export function removedAgents(state: AiAgentsState): { id: string; name: string }[] {
  return state.removed.flatMap((id) => {
    const kind = AI_AGENT_CATALOG.find((k) => k.id === id);
    return kind ? [{ id, name: kind.name }] : [];
  });
}

/**
 * The agents of the launch commands list: the installed ones and those with a command of their own first; the
 * others only when asked for.
 */
export function launchCommandAgents(
  state: AiAgentsState | null,
  commands: Readonly<Record<string, string>>,
  all: boolean,
): { id: string; name: string; command: string }[] {
  const kinds = AI_AGENT_CATALOG.filter((a) => a.category === 'agent');
  const relevant = (id: string) => !!commands[id]?.trim() || !!state?.agents.some((a) => a.id === id);
  return [...kinds.filter((k) => relevant(k.id)), ...(all ? kinds.filter((k) => !relevant(k.id)) : [])];
}
