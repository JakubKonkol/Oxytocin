import type { AgentLive } from '@shared/domain/ensemble';
import { isSafeToType } from '@shared/ensemble/prompts';

/**
 * Types a message into an agent's terminal (the most fragile part of Ensemble, kept small and explicit):
 * only while the agent is idle; a bracketed paste and Enter (PTY Host `paste`); then the agent must start working
 * within `confirmMs`, else Enter is sent once more; still nothing → the delivery failed and the user is asked.
 */

export interface DeliveryDeps {
  /** The agent's current state as the conductor sees it. */
  state(): AgentLive | undefined;
  /** Last output time of the agent's terminal (heuristic confirmation). */
  lastOutputAt(): number;
  /** When the agent was last seen working (a short turn may start and end between two polls). */
  lastWorkingAt(): number;
  paste(text: string): Promise<void>;
  /** Sends Enter again. */
  enter(): Promise<void>;
  /** Precise states (Claude Code's registry/hooks): confirmation waits for "working". */
  precise: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  confirmMs?: number;
  pollMs?: number;
}

/** `pasted`: the text reached the terminal (the agent may still start late). */
export type DeliveryResult = { ok: true } | { ok: false; error: string; pasted?: boolean };

/** Prompts on screen that must never receive a typed message. */
export const BLOCKING_PROMPT =
  /(do you trust|trust (this|the) (folder|directory|files|workspace)|press enter to (continue|confirm)|log ?in to|sign in|select (a|an) (login|auth)|\[y\/n\]|\(y\/n\))/i;

/**
 * A message as one line. On Windows a multi-line message is not typed as is: whether the paste markers survive the
 * console (ConPTY) up to the CLI is not guaranteed, and without them every line break would be an Enter that sends a
 * fragment. Line breaks become "↵"; oxy_ensemble_context serves the same text formatted.
 */
export const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join(' ↵ ')
    .replace(/( ↵ ){2,}/g, ' ↵ ↵ ');

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function deliver(text: string, deps: DeliveryDeps, signal?: AbortSignal): Promise<DeliveryResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const confirmMs = deps.confirmMs ?? 10_000;
  const pollMs = deps.pollMs ?? 200;
  if (!isSafeToType(text)) return { ok: false, error: 'Oxytocin never types slash commands into an agent.' };
  const state = deps.state();
  if (state !== 'idle') return { ok: false, error: `The agent is ${state ?? 'not running'}, not idle.` };

  const started = (since: number) => {
    const s = deps.state();
    if (s === 'working' || deps.lastWorkingAt() >= since) return true;
    if (s === 'exited') return true;
    // Heuristic CLIs: new output after the paste (beyond the echo of the text) means it reacted.
    return !deps.precise && deps.lastOutputAt() > since + 300;
  };
  const waitStarted = async (since: number) => {
    const deadline = now() + confirmMs;
    while (now() < deadline) {
      if (signal?.aborted) return false;
      if (started(since)) return true;
      await sleep(pollMs);
    }
    return started(since);
  };

  const pastedAt = now();
  await deps.paste(text);
  if (await waitStarted(pastedAt))
    return deps.state() === 'exited' ? { ok: false, error: 'The agent exited.' } : { ok: true };
  if (signal?.aborted) return { ok: false, error: 'Cancelled.', pasted: true };
  // The Enter may have been taken as part of the paste: one more.
  const retryAt = now();
  await deps.enter();
  if (await waitStarted(retryAt))
    return deps.state() === 'exited' ? { ok: false, error: 'The agent exited.' } : { ok: true };
  return {
    ok: false,
    error: 'The agent did not start working after the message. Open its terminal.',
    pasted: true,
  };
}
