import { create } from 'zustand';
import type { PromptContext } from './prompt-model';

export interface AskAgentRequest {
  id: number;
  projectId: string;
  contexts: PromptContext[];
  /** Preset chosen up front (e.g. "Explain" from a menu). */
  presetId?: string;
  /** Text to start with instead of a preset (e.g. a review prompt). */
  text?: string;
  /** Called after the prompt went to an agent (e.g. the review clears its comments). */
  onSent?: () => void;
}

interface AskAgentStore {
  request: AskAgentRequest | null;
  close: () => void;
}

export const useAskAgentStore = create<AskAgentStore>((set) => ({
  request: null,
  close: () => set({ request: null }),
}));

let nextId = 1;

/** Opens the "Ask agent" dialog about code or changes of a project. */
export function askAgent(req: Omit<AskAgentRequest, 'id'>): void {
  useAskAgentStore.setState({ request: { ...req, id: nextId++ } });
}
