import { z } from 'zod';
import {
  accountLabel,
  agentName,
  aiAccountLaunchId,
  aiAgentLaunchId,
  aiProfileLaunchId,
  presetOf,
  type AiAgentsState,
} from './ai-agents';

export interface AgentLauncher {
  launchId: string;
  name: string;
  detail?: string;
  kind: 'agent' | 'profile' | 'account';
  /** The CLI it starts: `claude`, `codex`, `gemini`… (API profiles run Claude Code). */
  agent: string;
}

/** The same choices in the workspace's + menu, Task and Changes. Never includes credentials. */
export function agentLaunchers(state: AiAgentsState | null): AgentLauncher[] {
  if (!state) return [];
  const hidden = new Set(state.hidden);
  return [
    ...state.agents
      .filter((a) => a.category === 'agent')
      .map((a): AgentLauncher => ({
        launchId: aiAgentLaunchId(a.id),
        name: a.name,
        kind: 'agent',
        agent: a.id,
        ...(accountLabel(a) ? { detail: accountLabel(a)! } : {}),
      })),
    ...state.accounts.map((a): AgentLauncher => ({
      launchId: aiAccountLaunchId(a.id),
      name: `${agentName(a.agent)} · ${a.name}`,
      kind: 'account',
      agent: a.agent,
      detail: accountLabel({ accounts: state.accountsInfo.logins[a.id] ?? [] }) ?? 'not signed in',
    })),
    ...state.profiles.map((p): AgentLauncher => ({
      launchId: aiProfileLaunchId(p.id),
      name: p.name,
      kind: 'profile',
      agent: 'claude',
      detail: `${presetOf(p.provider).label}${p.model ? ` · ${p.model}` : ''}`,
    })),
  ].filter((a) => !hidden.has(a.launchId));
}

export const AgentLaunchRequestSchema = z.object({
  projectId: z.string().min(1).max(64),
  launchId: z.string().startsWith('ai:').max(200),
  /** An explicitly selected existing session. Otherwise an idle matching session is reused. */
  terminalId: z.string().min(1).max(64).optional(),
  reuse: z.boolean().optional(),
  prompt: z.string().trim().min(1).max(200_000).optional(),
  /** Claude Code only; existing sessions retain their current mode. */
  planMode: z.boolean().optional(),
  /** Claude Code only: arguments added to the launch command of a new session (e.g. `--settings <file>`). */
  claudeArgs: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001f\u007f]+$/, 'Arguments cannot contain control characters.'),
    )
    .max(16)
    .optional(),
  /** Directories a new session may use besides the project (Claude Code, Codex CLI, Gemini CLI, Qwen Code). */
  addDirs: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        // eslint-disable-next-line no-control-regex
        .regex(/^[^\u0000-\u001f\u007f]+$/, 'Paths cannot contain control characters.'),
    )
    .max(8)
    .optional(),
  /** Environment variables of a new session's terminal. */
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096))
    .refine((env) => Object.keys(env).length <= 16, 'At most 16 variables.')
    .optional(),
});
export type AgentLaunchRequest = z.infer<typeof AgentLaunchRequestSchema>;
export const AgentLaunchResultSchema = z.object({
  terminalId: z.string(),
  reused: z.boolean(),
  sent: z.boolean(),
  error: z.string().optional(),
});
export type AgentLaunchResult = z.infer<typeof AgentLaunchResultSchema>;
