/** Shared between the Relay backend and its view. */

export type RelayMode = 'handoff' | 'review';

/** Per project (stored by the backend). Terminal ids refer to running agents; gone ones are ignored. */
export interface RelayConfig {
  enabled: boolean;
  mode: RelayMode;
  /** Hand-off order (agents not listed follow, oldest first). */
  order: string[];
  /** Agents left out. */
  excluded: string[];
  /** Review mode: the agent that reviews; the others are the authors. */
  reviewer: string | null;
  handoffPrompt: string;
  reviewPrompt: string;
  /** Hand off when the agent's 5-hour (or weekly) limit is at least this full (percent). */
  threshold: number;
  /** Review mode: only turns that changed files are reviewed. */
  onlyWithChanges: boolean;
}

export const DEFAULT_HANDOFF_PROMPT =
  '{from} stopped at its usage limit. Continue the implementation where it left off: check the current state (git status, the latest commits and the progress notes of the task) and carry on with the next step. Keep the progress notes up to date.';

export const DEFAULT_REVIEW_PROMPT =
  '{from} just finished a change. Review it: the uncommitted changes (git diff) and new commits. Changed files: {files}. Do not edit any file. Reply briefly: each problem with file:line and why, or "Looks good".';

export const DEFAULT_CONFIG: RelayConfig = {
  enabled: false,
  mode: 'handoff',
  order: [],
  excluded: [],
  reviewer: null,
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  reviewPrompt: DEFAULT_REVIEW_PROMPT,
  threshold: 90,
  onlyWithChanges: true,
};

export interface RelayParticipant {
  terminalId: string;
  /** "Claude (main)", "Codex (Work)". */
  label: string;
  title: string;
  state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown';
  included: boolean;
  /** Review mode. */
  reviewer: boolean;
  /** The fuller of the account's 5-hour and weekly windows; null: no reading. */
  limit: { percent: number; window: string; resetsAt: number | null } | null;
}

export interface RelayLogEntry {
  at: number;
  level: 'info' | 'warning';
  text: string;
}

export interface RelayViewState {
  projectId: string;
  projectName: string;
  config: RelayConfig;
  participants: RelayParticipant[];
  /** A hand-off or review waiting for an agent to become free. */
  pending: string | null;
  log: RelayLogEntry[];
  /** Whether some limits are known (the Usage Monitor reports them). */
  limitsKnown: boolean;
}
