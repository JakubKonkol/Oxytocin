import type { EnvLayer } from '../terminals/env-composer';
import type { EnvContribution } from './plugin-host-service';

export interface EnvTarget {
  projectId: string;
  profileId: string;
}

type Entry = EnvContribution['entries'][number];

export function scopeMatches(scope: Entry['scope'], target: EnvTarget): boolean {
  if (!scope) return true;
  if (scope.projectId && scope.projectId !== target.projectId) return false;
  if (scope.profileIds && scope.profileIds.length > 0 && !scope.profileIds.includes(target.profileId)) return false;
  return true;
}

const isPathVar = (name: string) => name.toUpperCase() === 'PATH';

/**
 * Environment layers contributed by plugins for one terminal: one layer
 * per plugin, applied after the project layer. `append`/`prepend` refer to the value composed so far through
 * `${env:NAME}` (the composer expands it); PATH uses the platform separator.
 */
export function pluginEnvLayers(
  contributions: readonly EnvContribution[],
  target: EnvTarget,
  platform: NodeJS.Platform,
): EnvLayer[] {
  const sep = platform === 'win32' ? ';' : ':';
  return contributions.map((c) => {
    const layer: Record<string, string | null> = {};
    for (const e of c.entries) {
      if (!scopeMatches(e.scope, target)) continue;
      const inherited = !(e.name in layer);
      const current = inherited ? `\${env:${e.name}}` : (layer[e.name] ?? '');
      // PATH always joins with the platform separator; other variables only with an explicit separator, and only
      // when the value so far is not empty (`\${ifenv:NAME:sep}` is expanded by the env composer).
      const custom = (e.separator ?? '').replace(/[{}:]/g, '');
      const joiner = isPathVar(e.name)
        ? sep
        : custom && inherited
          ? `\${ifenv:${e.name}:${custom}}`
          : custom && current
            ? custom
            : '';
      switch (e.op) {
        case 'replace':
          layer[e.name] = e.value ?? '';
          break;
        case 'append':
          layer[e.name] = `${current}${joiner}${e.value ?? ''}`;
          break;
        case 'prepend':
          layer[e.name] = `${e.value ?? ''}${joiner}${current}`;
          break;
        case 'delete':
          layer[e.name] = null;
          break;
      }
    }
    return layer;
  });
}

/** Whether a terminal is affected by a plugin's old or new collection (for `envStale`). */
export function affectedBy(
  before: EnvContribution | undefined,
  after: EnvContribution | undefined,
  target: EnvTarget,
): boolean {
  const entries = [...(before?.entries ?? []), ...(after?.entries ?? [])];
  return entries.some((e) => scopeMatches(e.scope, target));
}
