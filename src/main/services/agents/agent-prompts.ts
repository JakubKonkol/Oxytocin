import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { AgentLive } from '@shared/domain/ensemble';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { BLOCKING_PROMPT, deliver, type DeliveryResult, oneLine } from '../ensemble/prompt-delivery';

export interface AgentPromptDeps {
  agents: {
    list(): AgentInfoWithTerminal[];
    onDidUpdate(listener: (list: AgentInfoWithTerminal[]) => void): Disposable;
  };
  pty: {
    paste(id: string, text: string, submit: boolean): Promise<unknown>;
    write(id: string, data: string): Promise<unknown>;
    text(id: string): Promise<string>;
    onActivity(listener: (e: { id: string; lastOutputAt: number }) => void): Disposable;
  };
  platform: NodeJS.Platform;
  /** Delivery timing (tests). */
  confirmMs?: number;
}

/** Sources that report an agent's state exactly: a delivery waits for "working" instead of new output. */
const PRECISE_SOURCES = new Set(['hook', 'claude-registry', 'program-status']);

export const MAX_PROMPT_LENGTH = 8000;

/**
 * Types a prompt into the agent of a terminal for plugins (`oxy.agents.sendPrompt`), the way Ensemble does: only
 * while the agent waits for input, never over a question on screen (trust, login, y/n), then confirms it started.
 */
export class AgentPromptService implements Disposable {
  private readonly store = new DisposableStore();
  private readonly lastOutputAt = new Map<string, number>();
  private readonly lastWorkingAt = new Map<string, number>();
  private readonly delivering = new Set<string>();

  constructor(private readonly deps: AgentPromptDeps) {
    this.store.add(deps.pty.onActivity((e) => this.lastOutputAt.set(e.id, e.lastOutputAt)));
    this.store.add(
      deps.agents.onDidUpdate((list) => {
        for (const a of list) if (a.state === 'working') this.lastWorkingAt.set(a.terminalId, Date.now());
      }),
    );
  }

  private agent(terminalId: string): AgentInfoWithTerminal | undefined {
    return this.deps.agents.list().find((a) => a.terminalId === terminalId);
  }

  async send(terminalId: string, text: string): Promise<DeliveryResult> {
    const prompt = text.trim();
    if (!prompt) return { ok: false, error: 'The prompt is empty.' };
    if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, error: 'The prompt is too long.' };
    const agent = this.agent(terminalId);
    if (!agent) return { ok: false, error: 'No AI agent runs in this terminal.' };
    if (this.delivering.has(terminalId)) return { ok: false, error: 'A prompt is being sent to this agent already.' };
    this.delivering.add(terminalId);
    try {
      const screen = await this.deps.pty.text(terminalId).catch(() => '');
      if (BLOCKING_PROMPT.test(screen.split('\n').slice(-25).join('\n')))
        return { ok: false, error: 'A question is open in its terminal (trust, login, yes/no).' };
      return await deliver(prompt, {
        precise: PRECISE_SOURCES.has(agent.stateSource),
        state: (): AgentLive => this.agent(terminalId)?.state ?? 'exited',
        lastOutputAt: () => this.lastOutputAt.get(terminalId) ?? 0,
        lastWorkingAt: () => this.lastWorkingAt.get(terminalId) ?? 0,
        paste: async (t) => {
          await this.deps.pty.paste(terminalId, this.deps.platform === 'win32' ? oneLine(t) : t, true);
        },
        enter: async () => {
          await this.deps.pty.write(terminalId, '\r');
        },
        ...(this.deps.confirmMs !== undefined ? { confirmMs: this.deps.confirmMs } : {}),
      });
    } finally {
      this.delivering.delete(terminalId);
    }
  }

  forget(terminalId: string): void {
    this.lastOutputAt.delete(terminalId);
    this.lastWorkingAt.delete(terminalId);
  }

  dispose(): void {
    this.store.dispose();
  }
}
