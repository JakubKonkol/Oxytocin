import { z } from 'zod';

/**
 * AI agents: the coding agent CLIs installed on this computer and the accounts they are signed in with (detected on
 * demand in Settings → AI Agents), local model runtimes, and profiles that run Claude Code against another
 * Anthropic-compatible API (GLM, Kimi, OpenRouter, Ollama, llama.cpp…). The "+" menu of a workspace starts them.
 * The agents keep working exactly as when typed into a terminal: Oxytocin only starts them, and for a profile sets
 * the environment variables (the API key comes from the encrypted secret store).
 */

export interface AiAgentKind {
  id: string;
  name: string;
  /** The command typed into the shell. */
  command: string;
  /** Executables looked up on PATH (the first found wins). */
  executables: string[];
  vendor: string;
  /** `runtime`: a local model server (not started from the "+" menu; used by profiles). */
  category: 'agent' | 'runtime';
  /** Kept for existing setups only. */
  legacy?: boolean;
}

export const AI_AGENT_CATALOG: readonly AiAgentKind[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    executables: ['claude'],
    vendor: 'Anthropic',
    category: 'agent',
  },
  { id: 'codex', name: 'Codex CLI', command: 'codex', executables: ['codex'], vendor: 'OpenAI', category: 'agent' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', executables: ['gemini'], vendor: 'Google', category: 'agent' },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    executables: ['copilot'],
    vendor: 'GitHub',
    category: 'agent',
  },
  {
    id: 'gh-copilot',
    name: 'GitHub Copilot in the GitHub CLI',
    command: 'gh copilot',
    executables: ['gh'],
    vendor: 'GitHub',
    category: 'agent',
    legacy: true,
  },
  { id: 'grok', name: 'Grok CLI', command: 'grok', executables: ['grok'], vendor: 'xAI', category: 'agent' },
  { id: 'kiro', name: 'Kiro CLI', command: 'kiro-cli', executables: ['kiro-cli'], vendor: 'AWS', category: 'agent' },
  { id: 'kimi', name: 'Kimi CLI', command: 'kimi', executables: ['kimi'], vendor: 'Moonshot AI', category: 'agent' },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', executables: ['qwen'], vendor: 'Alibaba', category: 'agent' },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    executables: ['opencode'],
    vendor: 'SST',
    category: 'agent',
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    command: 'cursor-agent',
    executables: ['cursor-agent'],
    vendor: 'Cursor',
    category: 'agent',
  },
  { id: 'amp', name: 'Amp', command: 'amp', executables: ['amp'], vendor: 'Sourcegraph', category: 'agent' },
  {
    id: 'droid',
    name: 'Factory Droid',
    command: 'droid',
    executables: ['droid'],
    vendor: 'Factory',
    category: 'agent',
  },
  { id: 'aider', name: 'Aider', command: 'aider', executables: ['aider'], vendor: 'Aider', category: 'agent' },
  { id: 'goose', name: 'Goose', command: 'goose', executables: ['goose'], vendor: 'Block', category: 'agent' },
  { id: 'crush', name: 'Crush', command: 'crush', executables: ['crush'], vendor: 'Charm', category: 'agent' },
  { id: 'ollama', name: 'Ollama', command: 'ollama', executables: ['ollama'], vendor: 'Ollama', category: 'runtime' },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    command: 'llama-server',
    executables: ['llama-server'],
    vendor: 'ggml',
    category: 'runtime',
  },
];

export const AI_AGENT_IDS = AI_AGENT_CATALOG.map((a) => a.id);

export const AiAccountSchema = z.object({
  /** The e-mail address or login; for an API key the variable or file it comes from. */
  label: z.string().max(300),
  method: z.enum(['oauth', 'api-key', 'local', 'other']),
  /** "Max", "Plus", "Pro"… when the CLI stores it. */
  plan: z.string().max(100).optional(),
  /** "Organization: Acme", "providers: anthropic, openrouter". */
  detail: z.string().max(500).optional(),
});
export type AiAccount = z.infer<typeof AiAccountSchema>;

export const DetectedAiAgentSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(200),
  command: z.string().max(200),
  category: z.enum(['agent', 'runtime']),
  /** Where the executable was found. */
  path: z.string().max(2000).optional(),
  version: z.string().max(200).optional(),
  accounts: z.array(AiAccountSchema).max(20).default([]),
  /** Runtimes: whether the server answers, and its models. */
  running: z.boolean().optional(),
  models: z.array(z.string().max(300)).max(500).optional(),
  /** The server address of a runtime (e.g. http://127.0.0.1:11434). */
  url: z.string().max(500).optional(),
  legacy: z.boolean().optional(),
});
export type DetectedAiAgent = z.infer<typeof DetectedAiAgentSchema>;

// ── profiles: Claude Code against another Anthropic-compatible API ──

export interface AiProviderPreset {
  id: string;
  label: string;
  /** Anthropic-compatible base URL (Claude Code's ANTHROPIC_BASE_URL). */
  baseUrl: string;
  /** Runs on this computer: no API key needed. */
  local: boolean;
  modelHint: string;
  keyHint: string;
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: 'glm',
    label: 'GLM (Z.ai)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    local: false,
    modelHint: 'a GLM model id; empty: Z.ai maps the Claude model names',
    keyHint: 'Z.ai API key',
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot AI)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    local: false,
    modelHint: 'a Kimi model id',
    keyHint: 'Moonshot API key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    local: false,
    modelHint: 'a model id from openrouter.ai/models',
    keyHint: 'OpenRouter API key',
  },
  {
    id: 'orcarouter',
    label: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai',
    local: false,
    modelHint: 'e.g. orcarouter/auto',
    keyHint: 'OrcaRouter API key',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    local: false,
    modelHint: 'e.g. deepseek-chat',
    keyHint: 'DeepSeek API key',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    local: false,
    modelHint: 'a MiniMax model id',
    keyHint: 'MiniMax API key',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434',
    local: true,
    modelHint: 'a model you pulled, e.g. qwen3-coder',
    keyHint: 'not needed',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (local)',
    baseUrl: 'http://127.0.0.1:8080',
    local: true,
    modelHint: 'the model the server loaded',
    keyHint: 'only when the server was started with --api-key',
  },
  {
    id: 'custom',
    label: 'Other Anthropic-compatible API',
    baseUrl: '',
    local: false,
    modelHint: 'the provider’s model id',
    keyHint: 'API key or token',
  },
];

export const AI_PROVIDER_IDS = AI_PROVIDER_PRESETS.map((p) => p.id) as [string, ...string[]];
export const presetOf = (id: string): AiProviderPreset =>
  AI_PROVIDER_PRESETS.find((p) => p.id === id) ?? AI_PROVIDER_PRESETS.at(-1)!;

export const AI_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const AiProfileSchema = z.looseObject({
  id: z.string().regex(AI_PROFILE_ID_PATTERN),
  name: z.string().trim().min(1).max(100),
  /** The CLI that runs the profile (Claude Code: ANTHROPIC_BASE_URL and friends). */
  agent: z.literal('claude').default('claude'),
  provider: z.enum(AI_PROVIDER_IDS).default('custom'),
  baseUrl: z.string().max(2000),
  model: z.string().max(300).optional(),
  /** The model for quick background work (Claude Code's "Haiku" class); the main model when empty. */
  fastModel: z.string().max(300).optional(),
});
export type AiProfile = z.infer<typeof AiProfileSchema>;

/** The secret store's "project" of profile API keys (project ids are 12 hex characters). */
export const AI_PROFILE_SECRET_SCOPE = 'ai-profiles';

// ── added accounts: a second (third…) sign-in of Claude Code, Codex CLI or Gemini CLI ──

/** The agents that can have added accounts, and the variable that points each at an account's folder. */
export const AI_ACCOUNT_AGENTS = ['claude', 'codex', 'gemini'] as const;
export type AiAccountAgent = (typeof AI_ACCOUNT_AGENTS)[number];
export const AI_ACCOUNT_HOME_VARIABLES: Record<AiAccountAgent, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  gemini: 'GEMINI_CLI_HOME',
};

/**
 * An added account: its own configuration folder for the agent CLI (`~/.oxytocin/accounts/<agent>/<slug>`), so it
 * signs in separately and runs next to the main account. The main account (the CLI's default folder) is untouched.
 */
export const AgentAccountSchema = z.looseObject({
  id: z.string().regex(AI_PROFILE_ID_PATTERN),
  agent: z.enum(AI_ACCOUNT_AGENTS),
  /** Display name ("Work"); the signed-in e-mail is detected and shown next to it. */
  name: z.string().trim().min(1).max(100),
  /** Absolute folder; never changes after creation (macOS Keychain entries are keyed by it). */
  home: z.string().min(1).max(1000),
  /**
   * `shared`: global instructions, agents, skills, commands, settings and plugins come from the main account; the
   * sign-in, sessions, history and project memory stay separate. `isolated`: nothing is shared.
   */
  mode: z.enum(['shared', 'isolated']).default('shared'),
  createdAt: z.number(),
});
export type AgentAccount = z.infer<typeof AgentAccountSchema>;
export type AgentAccountMode = AgentAccount['mode'];

/** Settings → AI Agents: the main account's folder of each agent and what Oxytocin found about added accounts. */
export const AgentAccountsInfoSchema = z.object({
  /** The folder of each agent's main account (its CLI's default, or the user's own variable). */
  mainHomes: z.record(z.string(), z.string().max(1000)),
  /** Home variables (CLAUDE_CONFIG_DIR…) set in the user's environment: a shell profile may override accounts. */
  overridden: z.array(z.string().max(64)).max(10),
  /** Per account: who it is signed in with (empty: not signed in yet). */
  logins: z.record(z.string(), z.array(AiAccountSchema).max(20)),
  /** Per account: what could not be shared at the last start (e.g. a file of its own). */
  notes: z.record(z.string(), z.array(z.string().max(500)).max(50)),
});
export type AgentAccountsInfo = z.infer<typeof AgentAccountsInfoSchema>;

export const AiAgentsStateSchema = z.object({
  /** When detection last ran (ms); null: never. */
  detectedAt: z.number().nullable(),
  agents: z.array(DetectedAiAgentSchema).max(100),
  profiles: z.array(AiProfileSchema).max(100),
  /** Agents and profiles (launch ids) left out of the "+" menu. */
  hidden: z.array(z.string().max(200)).max(300),
  /** Profiles whose API key is stored. */
  keys: z.array(z.string()).max(100),
  /** API keys are encrypted with an OS key (false on Linux without a keyring: only obfuscated). */
  encrypted: z.boolean(),
  /** Added accounts of Claude Code, Codex CLI and Gemini CLI. */
  accounts: z.array(AgentAccountSchema).max(50).default([]),
  accountsInfo: AgentAccountsInfoSchema.default({ mainHomes: {}, overridden: [], logins: {}, notes: {} }),
});
export type AiAgentsState = z.infer<typeof AiAgentsStateSchema>;

/** The terminal profile id that starts a detected agent or a profile (`ai:claude`, `ai:profile:<id>`). */
export const aiAgentLaunchId = (agentId: string): string => `ai:${agentId}`;
export const aiProfileLaunchId = (profileId: string): string => `ai:profile:${profileId}`;
export const aiAccountLaunchId = (accountId: string): string => `ai:account:${accountId}`;
export const ACCOUNT_LAUNCH_PREFIX = 'ai:account:';
export const isAiLaunchId = (id: string): boolean => id.startsWith('ai:');

/** The account shown next to an agent's name ("you@example.com", "API key"). */
export function accountLabel(agent: Pick<DetectedAiAgent, 'accounts'>): string | undefined {
  const first = agent.accounts[0];
  if (!first) return undefined;
  const more = agent.accounts.length > 1 ? ` +${agent.accounts.length - 1}` : '';
  return `${first.label}${more}`;
}

const validUrl = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' && !u.username && !u.password;
  } catch {
    return false;
  }
};

/** Problems that block saving the profiles. */
export function validateProfiles(profiles: readonly AiProfile[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const p of profiles) {
    const key = p.name.trim().toLowerCase();
    if (names.has(key)) problems.push(`Two profiles are named "${p.name}".`);
    names.add(key);
    if (!validUrl(p.baseUrl)) problems.push(`${p.name}: the base URL must be an http(s) address without credentials.`);
  }
  return problems;
}

/**
 * The environment of a Claude Code session on a profile: the API, its key (or a placeholder for local servers),
 * and the model for every model class so Claude Code never asks the provider for a Claude model it lacks.
 * ANTHROPIC_API_KEY is emptied so a key of the user's environment does not take precedence.
 */
export function profileEnv(profile: AiProfile, apiKey: string | undefined): Record<string, string | null> {
  const preset = presetOf(profile.provider);
  const env: Record<string, string | null> = {
    ANTHROPIC_BASE_URL: profile.baseUrl.replace(/\/+$/, ''),
    ANTHROPIC_AUTH_TOKEN: apiKey ?? (preset.local ? preset.id : ''),
    ANTHROPIC_API_KEY: '',
  };
  const model = profile.model?.trim();
  const fast = profile.fastModel?.trim() || model;
  if (model) {
    env['ANTHROPIC_MODEL'] = model;
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = model;
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model;
    env['CLAUDE_CODE_SUBAGENT_MODEL'] = model;
  }
  if (fast) {
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = fast;
    env['ANTHROPIC_SMALL_FAST_MODEL'] = fast;
  }
  return env;
}

/** A new profile from a preset (local runtimes get their first detected model). */
export function newProfile(existing: readonly AiProfile[], providerId: string, model?: string): AiProfile {
  const preset = presetOf(providerId);
  const taken = new Set(existing.map((p) => p.id));
  let i = 1;
  let id = `p${Date.now().toString(36)}`;
  while (taken.has(id)) id = `p${Date.now().toString(36)}${i++}`;
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  const base = `Claude Code · ${preset.id === 'custom' ? 'API' : preset.label.replace(/ \(.*\)$/, '')}`;
  let name = base;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return AiProfileSchema.parse({
    id,
    name,
    agent: 'claude',
    provider: preset.id,
    baseUrl: preset.baseUrl,
    ...(model ? { model } : {}),
  });
}

// ── added accounts: helpers shared by main and the renderer ──

export const isAccountAgent = (id: string): id is AiAccountAgent =>
  (AI_ACCOUNT_AGENTS as readonly string[]).includes(id);

/** The agent's display name ("Claude Code"). */
export const agentName = (id: string): string => AI_AGENT_CATALOG.find((a) => a.id === id)?.name ?? id;

/**
 * The environment that starts the agent CLI on an account. For Claude Code, an API key or OAuth token of the user's
 * environment would take precedence over the account's own sign-in, so they are removed.
 */
export function accountEnv(account: Pick<AgentAccount, 'agent' | 'home'>): Record<string, string | null> {
  switch (account.agent) {
    case 'claude':
      return { CLAUDE_CONFIG_DIR: account.home, ANTHROPIC_API_KEY: null, CLAUDE_CODE_OAUTH_TOKEN: null };
    case 'codex':
      return { CODEX_HOME: account.home };
    case 'gemini':
      return { GEMINI_CLI_HOME: account.home };
  }
}

/** The folder name of a new account ("Work stuff" → "work-stuff"), unique among `taken` (case-insensitive). */
export function accountSlug(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // Letters without a decomposition.
      .replace(/[łđøßæœ]/g, (c) => ({ ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe' })[c] ?? c)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'account';
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** Problems that block adding an account with this name. */
export function validateAccountName(
  name: string,
  agent: AiAccountAgent,
  existing: readonly Pick<AgentAccount, 'agent' | 'name'>[],
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the account a name.';
  if (trimmed.length > 100) return 'The name is too long.';
  if (/^main$/i.test(trimmed)) return '"Main" is the name of the main account.';
  if (existing.some((a) => a.agent === agent && a.name.trim().toLowerCase() === trimmed.toLowerCase()))
    return `There is already an account named "${trimmed}".`;
  return undefined;
}

/**
 * A shell alias that starts the agent on the account outside Oxytocin (`claude-work`), for bash/zsh or PowerShell.
 */
export function accountAlias(account: Pick<AgentAccount, 'agent' | 'home'>, shell: 'posix' | 'powershell'): string {
  const variable = AI_ACCOUNT_HOME_VARIABLES[account.agent];
  const command = AI_AGENT_CATALOG.find((a) => a.id === account.agent)?.command ?? account.agent;
  const slug = account.home.split(/[\\/]/).filter(Boolean).at(-1) ?? 'account';
  const name = `${command}-${slug}`;
  if (shell === 'powershell') {
    const path = account.home.replace(/'/g, "''");
    return `function ${name} { $env:${variable} = '${path}'; try { ${command} @args } finally { Remove-Item Env:${variable} } }`;
  }
  // Escaped for the double quotes first, then for the single quotes around the alias.
  const path = account.home.replace(/(["$`\\])/g, '\\$1').replace(/'/g, `'\\''`);
  return `alias ${name}='${variable}="${path}" ${command}'`;
}
