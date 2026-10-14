import { create } from 'zustand';
import type { AiAgentsState } from '@shared/domain/ai-agents';
import { ipc } from '../../lib/ipc-client';

interface AiAgentsStore {
  state: AiAgentsState | null;
  detecting: boolean;
  /** Loads the state once and follows `aiAgents:changed`. */
  ensure: () => Promise<AiAgentsState | null>;
  detect: () => Promise<AiAgentsState>;
}

let subscribed = false;

/** Settings → AI Agents, shared by the settings view and the "+" menu. */
export const useAiAgentsStore = create<AiAgentsStore>((set, get) => ({
  state: null,
  detecting: false,
  async ensure() {
    if (!subscribed) {
      subscribed = true;
      ipc.on('aiAgents:changed', (state) => set({ state }));
    }
    const current = get().state;
    if (current) return current;
    const state = await ipc.invoke('aiAgents:get').catch(() => null);
    if (state) set({ state });
    return state;
  },
  async detect() {
    set({ detecting: true });
    try {
      const state = await ipc.invoke('aiAgents:detect');
      set({ state });
      return state;
    } finally {
      set({ detecting: false });
    }
  },
}));
