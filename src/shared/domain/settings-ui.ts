import { z } from 'zod';
import type { ConfigurationProperty } from './plugin';
import { CORE_SETTINGS, type CoreSettingKey, defaultSettingValue } from './settings';
import type { Platform } from './terminal-profile';

/** How a setting is edited in the settings UI (docs/plan/09-persistence-settings.md §3, roadmap M7-T3). */
export type SettingControl =
  | 'boolean'
  | 'number'
  | 'integer'
  | 'string'
  /** Empty input = null ("automatic"). */
  | 'nullableString'
  | 'enum'
  /** One string per line. */
  | 'stringList'
  /** Structured values: shown read-only, edited in settings.json. */
  | 'json';

export interface SettingDescriptor {
  key: string;
  /** Section in the settings UI: "Terminal", "Git"… or the plugin name. */
  section: string;
  title: string;
  description?: string;
  control: SettingControl;
  enumValues?: { value: unknown; label: string; description?: string }[];
  minimum?: number;
  maximum?: number;
  default: unknown;
  /** Contributed by a plugin. */
  pluginId?: string;
  /** Managed elsewhere (e.g. the Plugins panel): shown read-only. */
  readOnly?: boolean;
}

const SECTION_NAMES: Record<string, string> = {
  appearance: 'Appearance',
  terminal: 'Terminal',
  workspace: 'Workspace',
  git: 'Git',
  editor: 'Editor',
  notifications: 'Notifications',
  plugins: 'Plugins',
  updates: 'Updates',
  diagnostics: 'Diagnostics',
};
export const CORE_SECTIONS = Object.values(SECTION_NAMES);

/** Keys that only apply on one platform. */
const PLATFORM_KEYS: Partial<Record<CoreSettingKey, Platform>> = {
  'terminal.defaultProfile.windows': 'win32',
  'terminal.defaultProfile.osx': 'darwin',
  'terminal.defaultProfile.linux': 'linux',
  'terminal.windows.useBundledConpty': 'win32',
  'terminal.macOptionIsMeta': 'darwin',
};

const READ_ONLY_KEYS = new Set<string>(['plugins.enabled']);

const words = (segment: string) =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b(Ui|Os|Osc)\b/g, (w) => w.toUpperCase());

/**
 * "terminal.fontSize" → "Font Size"; "git.diff.sideBySide" → "Diff: Side By Side". The first segment is the
 * section (or the plugin prefix) and is left out.
 */
export function settingTitle(key: string): string {
  const parts = key.split('.').slice(1);
  if (parts.length === 0) return words(key);
  const last = words(parts.at(-1)!);
  const lead = parts.slice(0, -1).map(words);
  return lead.length ? `${lead.join(' ')}: ${last}` : last;
}

interface JsonSchemaLike {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaLike;
}

function controlOf(schema: JsonSchemaLike): Pick<SettingDescriptor, 'control' | 'minimum' | 'maximum'> & {
  enumValues?: unknown[];
} {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const range = {
    ...(schema.minimum !== undefined ? { minimum: schema.minimum } : {}),
    ...(schema.maximum !== undefined ? { maximum: schema.maximum } : {}),
  };
  if (schema.enum) return { control: 'enum', enumValues: schema.enum };
  if (types.length === 2 && types.includes('string') && types.includes('null')) return { control: 'nullableString' };
  if (types.length !== 1) return { control: 'json' };
  switch (types[0]) {
    case 'boolean':
      return { control: 'boolean' };
    case 'integer':
      return { control: 'integer', ...range };
    case 'number':
      return { control: 'number', ...range };
    case 'string':
      return { control: 'string' };
    case 'array':
      return schema.items?.type === 'string' && !schema.items.enum ? { control: 'stringList' } : { control: 'json' };
    default:
      return { control: 'json' };
  }
}

const enumLabel = (v: unknown) => (typeof v === 'string' ? words(v) : JSON.stringify(v));

/** Descriptors of the core settings that apply on this platform, in schema order. */
export function coreSettingDescriptors(platform: Platform): SettingDescriptor[] {
  const out: SettingDescriptor[] = [];
  for (const [key, definition] of Object.entries(CORE_SETTINGS) as [
    CoreSettingKey,
    (typeof CORE_SETTINGS)[CoreSettingKey],
  ][]) {
    const only = PLATFORM_KEYS[key];
    if (only && only !== platform) continue;
    const json = z.toJSONSchema(definition.schema as z.ZodType, { unrepresentable: 'any' }) as JsonSchemaLike;
    const { enumValues, ...control } = controlOf(json);
    const description = 'description' in definition ? (definition.description as string) : undefined;
    out.push({
      key,
      section: SECTION_NAMES[key.split('.')[0]!] ?? 'Other',
      title: settingTitle(key),
      ...(description ? { description } : {}),
      ...control,
      ...(enumValues ? { enumValues: enumValues.map((value) => ({ value, label: enumLabel(value) })) } : {}),
      default: defaultSettingValue(key, platform),
      ...(READ_ONLY_KEYS.has(key) ? { readOnly: true } : {}),
    });
  }
  return out;
}

/** Descriptors of a plugin's `contributes.configuration` properties. */
export function pluginSettingDescriptors(
  pluginId: string,
  pluginName: string,
  properties: Record<string, ConfigurationProperty>,
): SettingDescriptor[] {
  return Object.entries(properties).map(([key, prop]) => {
    const { enumValues, ...control } = controlOf({
      type: prop.type,
      ...(prop.enum ? { enum: prop.enum } : {}),
      ...(prop.minimum !== undefined ? { minimum: prop.minimum } : {}),
      ...(prop.maximum !== undefined ? { maximum: prop.maximum } : {}),
      ...(prop.type === 'array' ? { items: { type: 'string' } } : {}),
    });
    const description = prop.description ?? prop.markdownDescription;
    return {
      key,
      section: pluginName,
      title: settingTitle(key),
      ...(description ? { description } : {}),
      ...control,
      ...(enumValues
        ? {
            enumValues: enumValues.map((value, i) => ({
              value,
              label: enumLabel(value),
              ...(prop.enumDescriptions?.[i] ? { description: prop.enumDescriptions[i] } : {}),
            })),
          }
        : {}),
      default: prop.default,
      pluginId,
    };
  });
}

/** Validates a plugin setting value against its declared property (also used by main on `settings.update`). */
export function validateConfigValue(key: string, prop: ConfigurationProperty, value: unknown): string | null {
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

/** Validates a core setting value; null when valid. */
export function validateCoreValue(key: CoreSettingKey, value: unknown): string | null {
  const parsed = (CORE_SETTINGS[key].schema as z.ZodType).safeParse(value);
  return parsed.success ? null : parsed.error.issues.map((i) => i.message).join('; ');
}

/**
 * Turns form input into a setting value: numbers are parsed and range-checked, empty nullable strings become
 * null, lists are split into lines. Returns an error message for invalid input.
 */
export function parseSettingInput(d: SettingDescriptor, input: string): { value: unknown } | { error: string } {
  switch (d.control) {
    case 'number':
    case 'integer': {
      const text = input.trim();
      const n = Number(text);
      if (!text || !Number.isFinite(n)) return { error: 'Enter a number' };
      if (d.control === 'integer' && !Number.isInteger(n)) return { error: 'Enter a whole number' };
      if (d.minimum !== undefined && n < d.minimum) return { error: `Minimum is ${d.minimum}` };
      if (d.maximum !== undefined && n > d.maximum) return { error: `Maximum is ${d.maximum}` };
      return { value: n };
    }
    case 'nullableString':
      return { value: input.trim() === '' ? null : input };
    case 'stringList':
      return {
        value: input
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      };
    default:
      return { value: input };
  }
}

/** Text shown in an input for a value (inverse of `parseSettingInput`). */
export function formatSettingInput(d: SettingDescriptor, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (d.control === 'stringList' && Array.isArray(value)) return value.join('\n');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/** Whether a value differs from the default (deep comparison through JSON). */
export function isModified(d: SettingDescriptor, value: unknown): boolean {
  return value !== undefined && JSON.stringify(value) !== JSON.stringify(d.default);
}
