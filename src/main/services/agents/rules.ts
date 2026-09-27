import type { ProcInfo } from '@shared/domain/terminal';

export interface AgentRule {
  id: string;
  displayName: string;
  provider: 'anthropic' | 'openai' | 'google' | 'multi' | 'other';
  /** Case-insensitive executable names without extension. */
  processNames: string[];
  /** For agents started through an interpreter (node cli.js …). */
  commandLinePatterns?: RegExp[];
  icon: string;
}

/** extensible by plugins (`contributes.agents`, M5). */
export const DEFAULT_AGENT_RULES: AgentRule[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    provider: 'anthropic',
    processNames: ['claude'],
    commandLinePatterns: [/@anthropic-ai[\\/]claude-code/i],
    icon: 'claude',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    provider: 'openai',
    processNames: ['codex'],
    commandLinePatterns: [/@openai[\\/]codex/i],
    icon: 'openai',
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    provider: 'google',
    processNames: ['gemini'],
    commandLinePatterns: [/@google[\\/]gemini-cli/i],
    icon: 'gemini',
  },
  {
    id: 'aider',
    displayName: 'Aider',
    provider: 'multi',
    processNames: ['aider'],
    commandLinePatterns: [/-m\s+aider\b/i, /[\\/]aider(\.exe)?\b/i],
    icon: 'aider',
  },
  { id: 'opencode', displayName: 'OpenCode', provider: 'multi', processNames: ['opencode'], icon: 'opencode' },
  {
    id: 'copilot-cli',
    displayName: 'GitHub Copilot CLI',
    provider: 'multi',
    processNames: ['copilot'],
    commandLinePatterns: [/@github[\\/]copilot/i],
    icon: 'copilot',
  },
  {
    id: 'cursor-agent',
    displayName: 'Cursor Agent',
    provider: 'multi',
    processNames: ['cursor-agent'],
    icon: 'cursor',
  },
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    provider: 'other',
    processNames: ['qwen'],
    commandLinePatterns: [/@qwen-code/i],
    icon: 'qwen',
  },
];

const stripExe = (name: string) => name.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

export function matchAgentRule(proc: ProcInfo, rules: readonly AgentRule[]): AgentRule | undefined {
  const name = stripExe(proc.name);
  return rules.find(
    (r) =>
      r.processNames.some((n) => n.toLowerCase() === name) ||
      r.commandLinePatterns?.some((p) => p.test(proc.commandLine)),
  );
}

export type Classification =
  | { kind: 'shell' }
  | { kind: 'process'; foreground: ProcInfo }
  | { kind: 'agent'; rule: AgentRule; proc: ProcInfo; foreground: ProcInfo };

/**
 * Classifies a terminal from its descendants (nearest first): the nearest process matching an agent rule
 * makes it an `agent`, any other descendant a `process`, none a `shell`.
 */
export function classifyTerminal(
  descendants: readonly ProcInfo[],
  rules: readonly AgentRule[] = DEFAULT_AGENT_RULES,
): Classification {
  const foreground = descendants[0];
  if (!foreground) return { kind: 'shell' };
  for (const proc of descendants) {
    const rule = matchAgentRule(proc, rules);
    if (rule) return { kind: 'agent', rule, proc, foreground };
  }
  return { kind: 'process', foreground };
}
