import type { ConfigurationProperty } from '@shared/domain/plugin';
import { CORE_SETTINGS, type CoreSettingKey, type SettingsProblem } from '@shared/domain/settings';
import {
  CORE_SECTIONS,
  coreSettingDescriptors,
  isModified,
  pluginSettingDescriptors,
  type SettingDescriptor,
  validateConfigValue,
  validateCoreValue,
} from '@shared/domain/settings-ui';
import type { Platform } from '@shared/domain/terminal-profile';

export interface PluginConfiguration {
  pluginId: string;
  pluginName: string;
  properties: Record<string, ConfigurationProperty>;
}

/** Core settings (this platform) followed by the settings of each plugin. */
export function allDescriptors(platform: Platform, plugins: readonly PluginConfiguration[]): SettingDescriptor[] {
  return [
    ...coreSettingDescriptors(platform),
    ...plugins.flatMap((p) => pluginSettingDescriptors(p.pluginId, p.pluginName, p.properties)),
  ];
}

/** Sections in display order: core sections, then plugins alphabetically. */
export function sectionsOf(descriptors: readonly SettingDescriptor[]): string[] {
  const present = new Set(descriptors.map((d) => d.section));
  const plugins = [...new Set(descriptors.filter((d) => d.pluginId).map((d) => d.section))].sort((a, b) =>
    a.localeCompare(b),
  );
  return [...CORE_SECTIONS.filter((s) => present.has(s)), ...plugins];
}

/** The effective value: settings.json, else the default. */
export function valueOf(d: SettingDescriptor, settings: Readonly<Record<string, unknown>>): unknown {
  return settings[d.key] !== undefined ? settings[d.key] : d.default;
}

/**
 * Filters by a query: every word must appear in the title, key, description or section; the `@modified`
 * token keeps only settings that differ from their defaults.
 */
export function filterDescriptors(
  descriptors: readonly SettingDescriptor[],
  query: string,
  settings: Readonly<Record<string, unknown>>,
): SettingDescriptor[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const modifiedOnly = tokens.includes('@modified');
  const words = tokens.filter((t) => t !== '@modified');
  return descriptors.filter((d) => {
    if (modifiedOnly && !isModified(d, settings[d.key])) return false;
    const haystack = `${d.title} ${d.key} ${d.description ?? ''} ${d.section}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/**
 * Problems to show: invalid core values reported by main plus plugin values that do not match their declared
 * property (the plugin then sees its default).
 */
export function settingsProblems(
  core: readonly SettingsProblem[],
  plugins: readonly PluginConfiguration[],
  settings: Readonly<Record<string, unknown>>,
): SettingsProblem[] {
  const out = [...core];
  for (const p of plugins) {
    for (const [key, prop] of Object.entries(p.properties)) {
      if (settings[key] === undefined) continue;
      const problem = validateConfigValue(key, prop, settings[key]);
      if (problem) out.push({ key, message: problem });
    }
  }
  return out;
}

/** Validates a value before writing it. */
export function validateValue(
  d: SettingDescriptor,
  value: unknown,
  plugins: readonly PluginConfiguration[],
): string | null {
  if (d.pluginId) {
    const prop = plugins.find((p) => p.pluginId === d.pluginId)?.properties[d.key];
    return prop ? validateConfigValue(d.key, prop, value) : null;
  }
  return d.key in CORE_SETTINGS ? validateCoreValue(d.key as CoreSettingKey, value) : null;
}
