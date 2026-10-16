import { z } from 'zod';
import { AI_ACCOUNT_AGENTS } from './ai-agents';

/**
 * Plan limits of AI agent accounts (Claude Code's 5-hour and weekly limits, Codex CLI's primary and secondary
 * windows). The Usage Monitor reads them and reports them to Oxytocin (`oxy.agents.reportLimits`); other plugins read
 * them back (`oxy.agents.getLimits`), e.g. to hand work over before an account runs out.
 */

/** The account of the CLI's default folder; added accounts use their own id (`acc_…`). */
export const MAIN_ACCOUNT_ID = 'main';

export const AgentLimitWindowSchema = z.object({
  /** The agent's own name of the window: `five_hour`, `seven_day`, `primary`, `secondary`… */
  window: z.string().min(1).max(64),
  usedPercent: z.number().finite().min(0).max(1000),
  /** Length of the window (300: five hours, 10080: a week); null: not time-based (e.g. a spend limit). */
  windowMinutes: z.number().finite().positive().nullable(),
  /** When the window starts over (ms); null: unknown. */
  resetsAt: z.number().finite().nullable(),
  /** When the agent reported this (ms). */
  observedAt: z.number().finite(),
});
export type AgentLimitWindow = z.infer<typeof AgentLimitWindowSchema>;

export const AgentLimitsSchema = z.object({
  agent: z.enum(AI_ACCOUNT_AGENTS),
  accountId: z.string().min(1).max(100),
  windows: z.array(AgentLimitWindowSchema).max(10),
});
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;

/** An account as plugins see it (the main account of each CLI and the added ones). */
export const AgentAccountInfoSchema = z.object({
  id: z.string(),
  agent: z.enum(AI_ACCOUNT_AGENTS),
  /** `main`, or the name the user gave the account ("Work"). */
  name: z.string(),
  main: z.boolean(),
  /** CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME of the account (resolved for the main one too). */
  home: z.string(),
});
export type AgentAccountInfo = z.infer<typeof AgentAccountInfoSchema>;

/** The agent detection's ids (`claude-code`, `codex`, `gemini-cli`) → the agents that have accounts. */
export const ACCOUNT_AGENT_OF: Readonly<Record<string, (typeof AI_ACCOUNT_AGENTS)[number]>> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
};

/** The usage of a window now: a window whose reset time has passed starts over at 0. */
export function currentUsage(w: AgentLimitWindow, now: number): number {
  return w.resetsAt !== null && w.resetsAt <= now ? 0 : w.usedPercent;
}

/**
 * The time-based window that is closest to running out (the 5-hour or the weekly one, whichever is fuller): an
 * account stops working when either is used up. Null when the account reported no time-based window.
 */
export function blockingWindow(
  limits: Pick<AgentLimits, 'windows'> | undefined,
  now: number,
): (AgentLimitWindow & { current: number }) | null {
  let best: (AgentLimitWindow & { current: number }) | null = null;
  for (const w of limits?.windows ?? []) {
    if (w.windowMinutes === null) continue;
    const current = currentUsage(w, now);
    // Ties go to the shorter window (it resets sooner, so its numbers are the ones that matter now).
    if (!best || current > best.current || (current === best.current && w.windowMinutes < (best.windowMinutes ?? 0)))
      best = { ...w, current };
  }
  return best;
}
