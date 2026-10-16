import {
  accountLabel,
  type AgentAccount,
  type AiAgentsState,
  type AiProfile,
  agentName,
  aiAccountLaunchId,
  aiAgentLaunchId,
  aiProfileLaunchId,
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
export function menuEntries(state: AiAgentsState | null): AiMenuEntry[] {
  if (!state) return [];
  const hidden = new Set(state.hidden);
  const agents: AiMenuEntry[] = state.agents
    .filter((a) => a.category === 'agent' && !hidden.has(aiAgentLaunchId(a.id)))
    .map((a) => {
      const account = accountLabel(a);
      return { launchId: aiAgentLaunchId(a.id), name: a.name, ...(account ? { detail: account } : {}), kind: 'agent' };
    });
  const profiles: AiMenuEntry[] = state.profiles
    .filter((p) => !hidden.has(aiProfileLaunchId(p.id)))
    .map((p) => ({ launchId: aiProfileLaunchId(p.id), name: p.name, detail: profileDetail(p), kind: 'profile' }));
  const accounts: AiMenuEntry[] = state.accounts
    .filter((a) => !hidden.has(aiAccountLaunchId(a.id)))
    .map((a) => ({
      launchId: aiAccountLaunchId(a.id),
      name: accountTitle(a),
      detail: accountLoginText(state, a.id),
      kind: 'account',
    }));
  return [...agents, ...accounts, ...profiles];
}

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
