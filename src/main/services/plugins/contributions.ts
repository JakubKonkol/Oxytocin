import type { Contributions } from '@shared/domain/plugin';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import type { AgentRule } from '../agents/rules';

/** `contributes.terminalProfiles` → terminal profiles (agents run as "default shell + typed command"). */
export function pluginTerminalProfiles(contributions: Contributions): TerminalProfile[] {
  return contributions.terminalProfiles.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    file: p.kind === 'shell' ? (p.command ?? '') : '',
    args: p.kind === 'shell' ? (p.args ?? []) : [],
    ...(p.env ? { env: p.env } : {}),
    ...(p.icon ? { icon: p.icon } : {}),
    source: 'plugin',
    ...(p.kind === 'agent' && p.command ? { command: [p.command, ...(p.args ?? [])].join(' ') } : {}),
  }));
}

/** `contributes.agents` → agent rules (pattern strings compiled case-insensitively; invalid ones skipped). */
export function compilePluginAgentRules(contributions: Contributions): AgentRule[] {
  return contributions.agents.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    provider: a.provider,
    processNames: a.processNames,
    commandLinePatterns: (a.commandLinePatterns ?? []).flatMap((source) => {
      try {
        return [new RegExp(source, 'i')];
      } catch {
        return [];
      }
    }),
    icon: a.icon,
  }));
}

export { validateConfigValue } from '@shared/domain/settings-ui';

/** Default values of all contributed settings (used when settings.json has no value). */
export function configDefaults(contributions: Contributions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of contributions.configuration) {
    for (const [key, prop] of Object.entries(c.properties)) if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}
