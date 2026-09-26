import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { type DetectDeps, which } from './deps';

export const AGENT_COMMANDS = [
  { id: 'agent:claude', name: 'Claude Code', command: 'claude', icon: 'agent-claude' },
  { id: 'agent:codex', name: 'Codex CLI', command: 'codex', icon: 'agent-openai' },
  { id: 'agent:gemini', name: 'Gemini CLI', command: 'gemini', icon: 'agent-gemini' },
  { id: 'agent:aider', name: 'Aider', command: 'aider', icon: 'agent-aider' },
  { id: 'agent:opencode', name: 'OpenCode', command: 'opencode', icon: 'agent-opencode' },
] as const;

/** Built-in agent profiles, only for agents found on PATH. They run as "default shell + typed command". */
export async function detectAgentProfiles(deps: DetectDeps): Promise<TerminalProfile[]> {
  const out: TerminalProfile[] = [];
  for (const agent of AGENT_COMMANDS) {
    if (await which(agent.command, deps)) {
      out.push({
        id: agent.id,
        name: agent.name,
        kind: 'agent',
        file: '',
        args: [],
        icon: agent.icon,
        source: 'builtin-agent',
        command: agent.command,
      });
    }
  }
  return out;
}
