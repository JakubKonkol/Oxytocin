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

export interface ConfigProperty {
  type: 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

/** Checks a value against a `contributes.configuration` property (JSON Schema subset, 07 §8.5). */
export function validateConfigValue(key: string, prop: ConfigProperty, value: unknown): string | null {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const ok =
    prop.type === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : prop.type === 'object'
        ? type === 'object'
        : type === prop.type;
  if (!ok) return `${key} must be of type ${prop.type}`;
  if (prop.enum && !prop.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    return `${key} must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  if (typeof value === 'number') {
    if (prop.minimum !== undefined && value < prop.minimum) return `${key} must be ≥ ${prop.minimum}`;
    if (prop.maximum !== undefined && value > prop.maximum) return `${key} must be ≤ ${prop.maximum}`;
  }
  return null;
}

/** Default values of all contributed settings (used when settings.json has no value). */
export function configDefaults(contributions: Contributions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of contributions.configuration) {
    for (const [key, prop] of Object.entries(c.properties)) if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}
