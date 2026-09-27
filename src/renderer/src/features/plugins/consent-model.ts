import { PERMISSION_DESCRIPTIONS, type PluginDescriptor, type PluginPermission } from '@shared/domain/plugin';

/** A plugin installed by the user runs only after the user agreed (07 §2); `plugins.enabled` records the answer. */
export function needsConsent(plugin: PluginDescriptor, enabled: Readonly<Record<string, boolean>>): boolean {
  return plugin.source === 'user' && enabled[plugin.id] === undefined;
}

export interface ConsentDetails {
  publisher: string;
  /** The plugin runs Node.js code in the Plugin Host (no sandbox). */
  hasBackend: boolean;
  permissions: { id: PluginPermission; description: string }[];
  /** It replaces a built-in plugin with the same id. */
  replacesBuiltin: boolean;
}

export function consentDetails(plugin: PluginDescriptor): ConsentDetails {
  const m = plugin.manifest;
  return {
    publisher: plugin.publisher ?? 'an unknown publisher',
    hasBackend: !!m?.main,
    permissions: (m?.permissions ?? []).map((id) => ({ id, description: PERMISSION_DESCRIPTIONS[id] })),
    replacesBuiltin: (plugin.shadowed ?? []).some((s) => s.source === 'builtin'),
  };
}

export const BACKEND_WARNING =
  'Plugins with a backend have full access to your computer — install only from sources you trust.';
