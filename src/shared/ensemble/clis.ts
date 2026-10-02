import type { EnsembleCli, PermissionMode } from '../domain/ensemble';

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** The picker's group: current models, aliases (always the latest of a family) and older models. */
  group?: 'current' | 'alias' | 'older';
}

/** What the builder knows about each CLI (verified against the versions in the plan's verification log). */
export interface CliInfo {
  cli: EnsembleCli;
  displayName: string;
  /** Default command (settings `ensemble.commands` override it). */
  command: string;
  models: ModelOption[];
  /** Effort levels (empty: the CLI has no effort setting). */
  efforts: string[];
  permissionModes: PermissionMode[];
  /** Layers 1–3 go into a system prompt file (otherwise oxy_ensemble_context serves them). */
  systemPromptFile: boolean;
  /** `--resume` after an app restart. */
  resume: boolean;
  /** How exactly Oxytocin knows when it is idle. */
  states: 'registry' | 'heuristic';
  installHint: string;
}

export const CLI_INFO: Record<EnsembleCli, CliInfo> = {
  'claude-code': {
    cli: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'planning, hard coding work', group: 'current' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'fast everyday coding', group: 'current' },
      {
        id: 'claude-fable-5-1',
        label: 'Claude Fable 5.1',
        hint: 'the most capable, the most expensive',
        group: 'current',
      },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fast and cheap', group: 'current' },
      { id: 'opus', label: 'opus', hint: 'the latest Opus', group: 'alias' },
      { id: 'sonnet', label: 'sonnet', hint: 'the latest Sonnet', group: 'alias' },
      { id: 'fable', label: 'fable', hint: 'the latest Fable', group: 'alias' },
      { id: 'haiku', label: 'haiku', hint: 'the latest Haiku', group: 'alias' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'older' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'older' },
      { id: 'claude-fable-5', label: 'Claude Fable 5', group: 'older' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'older' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'older' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    systemPromptFile: true,
    resume: true,
    states: 'registry',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    cli: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    ],
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    systemPromptFile: false,
    resume: false,
    states: 'heuristic',
    installHint: 'npm install -g @openai/codex',
  },
  'gemini-cli': {
    cli: 'gemini-cli',
    displayName: 'Gemini CLI',
    command: 'gemini',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    efforts: [],
    permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    systemPromptFile: false,
    resume: false,
    states: 'heuristic',
    installHint: 'npm install -g @google/gemini-cli',
  },
  opencode: {
    cli: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    models: [
      { id: 'anthropic/claude-opus-5-5', label: 'anthropic/claude-opus-5-5' },
      { id: 'anthropic/claude-sonnet-5-5', label: 'anthropic/claude-sonnet-5-5' },
      { id: 'openai/gpt-5.5', label: 'openai/gpt-5.5' },
    ],
    efforts: [],
    permissionModes: ['default', 'plan'],
    systemPromptFile: false,
    resume: false,
    states: 'heuristic',
    installHint: 'npm install -g opencode-ai',
  },
  custom: {
    cli: 'custom',
    displayName: 'Custom command',
    command: '',
    models: [],
    efforts: [],
    permissionModes: ['default'],
    systemPromptFile: false,
    resume: false,
    states: 'heuristic',
    installHint: 'Any interactive CLI; {{model}}, {{promptFile}}, {{mcpUrl}}, {{mcpConfigFile}} are replaced.',
  },
};

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask (default)',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
};

/** The MCP server name Ensemble agents see (separate from the user's `oxytocin` server). */
export const ENSEMBLE_MCP_SERVER = 'oxytocin-ensemble';
/** Path of the Ensemble endpoint on Oxytocin's MCP server. */
export const ENSEMBLE_MCP_PATH = '/mcp/ensemble';
/** Environment variable with the agent's role token (its bearer token on the Ensemble endpoint). */
export const ENSEMBLE_TOKEN_ENV = 'OXYTOCIN_ENSEMBLE_TOKEN';
