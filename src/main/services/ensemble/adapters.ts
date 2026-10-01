import type { EnsembleAgent, EnsembleCli } from '@shared/domain/ensemble';
import { CLI_INFO, ENSEMBLE_MCP_SERVER, ENSEMBLE_TOKEN_ENV } from '@shared/ensemble/clis';

/**
 * Agent adapters: the command line, environment and files that start one Ensemble agent. Pure (no I/O), so every
 * command line is unit-tested. Isolation: only per-session flags, environment variables and files in Oxytocin's
 * own folder are used — never `/model`, `/effort` or a write to the CLI's settings.
 */

export interface LaunchContext {
  /** The agent's command (settings `ensemble.commands`, else the CLI's default). */
  command: string;
  /** Layers 1–3 (written to `promptFile` when the CLI reads one). */
  promptFile: string;
  /** A per-agent file Oxytocin may write (MCP configuration). */
  configFile: string;
  /** `http://127.0.0.1:<port>/mcp/ensemble`. */
  mcpUrl: string;
  /** The agent's role token: its bearer token on the Ensemble endpoint. */
  token: string;
  /** New session id (CLIs that accept one). */
  sessionId: string;
  /** Session to continue (an app restart). */
  resumeSessionId?: string | undefined;
  /** Display name of the session ("ens:<task>/<agent>"). */
  sessionName: string;
}

export interface LaunchFile {
  path: string;
  content: string;
  /** Contains the role token: written with owner-only permissions and removed when the run ends. */
  secret?: boolean;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  files: LaunchFile[];
  /** The CLI session id Oxytocin chose (or resumed). */
  cliSessionId?: string;
}

const mcpServerJson = (ctx: LaunchContext) => ({
  type: 'http',
  url: ctx.mcpUrl,
  headers: { Authorization: `Bearer ${ctx.token}` },
});

function claude(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  const args: string[] = [];
  if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
  else args.push('--session-id', ctx.sessionId);
  args.push('--name', ctx.sessionName);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  args.push('--append-system-prompt-file', ctx.promptFile);
  // A server of its own for this session: the user's MCP servers (including `oxytocin`) stay as they are.
  args.push('--mcp-config', ctx.configFile);
  // Calls of the Ensemble tools never wait for a permission prompt.
  args.push('--allowedTools', `mcp__${ENSEMBLE_MCP_SERVER}`);
  if (agent.readOnly) args.push('--disallowedTools', 'Edit,Write,NotebookEdit');
  if (agent.permissionMode !== 'default') args.push('--permission-mode', agent.permissionMode);
  args.push(...agent.extraArgs);
  return {
    command: ctx.command,
    args,
    env: { [ENSEMBLE_TOKEN_ENV]: ctx.token },
    files: [
      {
        path: ctx.configFile,
        content: JSON.stringify({ mcpServers: { [ENSEMBLE_MCP_SERVER]: mcpServerJson(ctx) } }, null, 2),
        secret: true,
      },
    ],
    cliSessionId: ctx.resumeSessionId ?? ctx.sessionId,
  };
}

function codex(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  const server = ENSEMBLE_MCP_SERVER.replace(/-/g, '_');
  const args: string[] = [];
  if (agent.model) args.push('-m', agent.model);
  if (agent.effort) args.push('-c', `model_reasoning_effort=${agent.effort}`);
  // `-c` values that are not TOML are taken literally (no quotes to survive the shell).
  args.push('-c', `mcp_servers.${server}.url=${ctx.mcpUrl}`);
  args.push('-c', `mcp_servers.${server}.bearer_token_env_var=${ENSEMBLE_TOKEN_ENV}`);
  args.push('-c', `mcp_servers.${server}.default_tools_approval_mode=approve`);
  if (agent.readOnly) args.push('-s', 'read-only');
  else if (agent.permissionMode === 'acceptEdits') args.push('-s', 'workspace-write');
  else if (agent.permissionMode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push(...agent.extraArgs);
  return { command: ctx.command, args, env: { [ENSEMBLE_TOKEN_ENV]: ctx.token }, files: [] };
}

function gemini(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  const args: string[] = ['--session-id', ctx.sessionId, '--skip-trust'];
  if (agent.model) args.push('-m', agent.model);
  const mode = agent.readOnly
    ? 'plan'
    : agent.permissionMode === 'acceptEdits'
      ? 'auto_edit'
      : agent.permissionMode === 'bypassPermissions'
        ? 'yolo'
        : agent.permissionMode === 'plan'
          ? 'plan'
          : undefined;
  if (mode) args.push('--approval-mode', mode);
  args.push(...agent.extraArgs);
  // Gemini CLI merges `mcpServers` of this settings file over the user's (shallow merge: theirs stay).
  const settings = {
    mcpServers: {
      [ENSEMBLE_MCP_SERVER]: { httpUrl: ctx.mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` }, trust: true },
    },
  };
  return {
    command: ctx.command,
    args,
    env: { [ENSEMBLE_TOKEN_ENV]: ctx.token, GEMINI_CLI_SYSTEM_SETTINGS_PATH: ctx.configFile },
    files: [{ path: ctx.configFile, content: JSON.stringify(settings, null, 2), secret: true }],
    cliSessionId: ctx.sessionId,
  };
}

function opencode(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  const args: string[] = [];
  if (agent.model) args.push('-m', agent.model);
  if (agent.readOnly || agent.permissionMode === 'plan') args.push('--agent', 'plan');
  args.push(...agent.extraArgs);
  const config = {
    mcp: {
      [ENSEMBLE_MCP_SERVER]: {
        type: 'remote',
        url: ctx.mcpUrl,
        headers: { Authorization: `Bearer ${ctx.token}` },
        enabled: true,
      },
    },
  };
  return {
    command: ctx.command,
    args,
    // Merged over the user's configuration for this process only.
    env: { [ENSEMBLE_TOKEN_ENV]: ctx.token, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    files: [],
  };
}

/** `{{name}}` placeholders of a custom command; their values are quoted by the caller per shell. */
export const CUSTOM_PLACEHOLDERS = ['model', 'effort', 'promptFile', 'mcpUrl', 'mcpConfigFile', 'sessionId'] as const;

function custom(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  return {
    command: agent.customCommand?.trim() ?? '',
    args: [...agent.extraArgs],
    env: {
      [ENSEMBLE_TOKEN_ENV]: ctx.token,
      OXYTOCIN_ENSEMBLE_MCP_URL: ctx.mcpUrl,
      OXYTOCIN_ENSEMBLE_PROMPT_FILE: ctx.promptFile,
      OXYTOCIN_ENSEMBLE_MCP_CONFIG: ctx.configFile,
    },
    files: [
      {
        path: ctx.configFile,
        content: JSON.stringify({ mcpServers: { [ENSEMBLE_MCP_SERVER]: mcpServerJson(ctx) } }, null, 2),
        secret: true,
      },
    ],
    cliSessionId: ctx.sessionId,
  };
}

const BUILDERS: Record<EnsembleCli, (agent: EnsembleAgent, ctx: LaunchContext) => LaunchSpec> = {
  'claude-code': claude,
  codex,
  'gemini-cli': gemini,
  opencode,
  custom,
};

export function buildLaunch(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec {
  return BUILDERS[agent.cli](agent, ctx);
}

/** Values of a custom command's placeholders. */
export function customValues(
  agent: EnsembleAgent,
  ctx: LaunchContext,
): Record<(typeof CUSTOM_PLACEHOLDERS)[number], string> {
  return {
    model: agent.model ?? '',
    effort: agent.effort ?? '',
    promptFile: ctx.promptFile,
    mcpUrl: ctx.mcpUrl,
    mcpConfigFile: ctx.configFile,
    sessionId: ctx.sessionId,
  };
}

/** Whether the CLI reads layers 1–3 from the prompt file (else oxy_ensemble_context serves them). */
export const readsPromptFile = (cli: EnsembleCli): boolean => CLI_INFO[cli].systemPromptFile;

/** A session display name: "ens:<task>/<agent>" with characters every shell and CLI accepts. */
export function sessionName(taskTitle: string, agentName: string): string {
  const clean = (s: string, n: number) =>
    s
      .replace(/[^\w .-]+/g, '')
      .trim()
      .slice(0, n) || 'x';
  return `ens:${clean(taskTitle, 40)}/${clean(agentName, 30)}`;
}
