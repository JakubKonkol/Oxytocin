import { join } from 'node:path';
import semver from 'semver';
import {
  type Contributions,
  type PluginDescriptor,
  type PluginManifest,
  PluginManifestSchema,
  type PluginSource,
} from '@shared/domain/plugin';

export interface DiscoveryFs {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface Candidate {
  source: PluginSource;
  path: string;
  version: string;
  manifest?: PluginManifest;
  /** id from the manifest even when invalid (for conflict resolution). */
  id?: string;
  errors: string[];
}

const SOURCE_RANK: Record<PluginSource, number> = { dev: 3, user: 2, builtin: 1 };

/** Reads and validates one plugin folder (`package.json` with an `oxytocin` section). */
export async function readPlugin(dir: string, source: PluginSource, fs: DiscoveryFs): Promise<Candidate | null> {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await fs.readFile(join(dir, 'package.json'))) as Record<string, unknown>;
  } catch (e) {
    if (!(await fs.exists(join(dir, 'package.json')))) return null;
    return {
      source,
      path: dir,
      version: '0.0.0',
      errors: [`package.json: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const version = typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
  const raw = pkg['oxytocin'];
  if (raw === undefined) return null;
  const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      source,
      path: dir,
      version,
      ...(typeof rawId === 'string' ? { id: rawId } : {}),
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'oxytocin'}: ${i.message}`),
    };
  }
  const manifest = parsed.data;
  const errors: string[] = [];
  // Referenced files must exist, so a broken build shows a readable error instead of an empty view.
  const files = [
    ...(manifest.main ? [['main', manifest.main]] : []),
    ...manifest.contributes.views.map((v) => [`views.${v.id}.entry`, v.entry]),
    ...manifest.contributes.panels.map((p) => [`panels.${p.type}.entry`, p.entry]),
  ] as [string, string][];
  for (const [what, file] of files) {
    if (!(await fs.exists(join(dir, file)))) errors.push(`${what}: file not found (${file})`);
  }
  return { source, path: dir, version, manifest, id: manifest.id, errors };
}

/** Plugin folders directly inside `dir`. */
export async function scanDir(dir: string, source: PluginSource, fs: DiscoveryFs): Promise<Candidate[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Candidate[] = [];
  for (const name of names.sort()) {
    const c = await readPlugin(join(dir, name), source, fs).catch(() => null);
    if (c) out.push(c);
  }
  return out;
}

/** One candidate per id: dev > user > builtin; the others are listed as shadowed. */
export function resolveConflicts(candidates: readonly Candidate[]): (Candidate & { shadowed: Candidate[] })[] {
  const byId = new Map<string, Candidate[]>();
  const anonymous: Candidate[] = [];
  for (const c of candidates) {
    if (!c.id) {
      anonymous.push(c);
      continue;
    }
    const list = byId.get(c.id) ?? [];
    list.push(c);
    byId.set(c.id, list);
  }
  const out = [...byId.values()].map((list) => {
    const sorted = [...list].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
    return { ...sorted[0]!, shadowed: sorted.slice(1) };
  });
  return [...out, ...anonymous.map((c) => ({ ...c, shadowed: [] }))];
}

export function isEngineCompatible(engine: string, apiVersion: string): boolean {
  const range = semver.validRange(engine);
  return range !== null && semver.satisfies(apiVersion, range, { includePrerelease: true });
}

/**
 * Descriptors with states: invalid (manifest/files, configuration prefix clash), incompatible (`engine`),
 * disabled (`plugins.enabled[id] === false`; user plugins stay disabled until enabled explicitly), enabled.
 */
export function describePlugins(
  resolved: readonly (Candidate & { shadowed: Candidate[] })[],
  enabled: Readonly<Record<string, boolean>>,
  apiVersion: string,
): PluginDescriptor[] {
  const prefixes = new Map<string, string>();
  const sorted = [...resolved].sort(
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.id ?? a.path).localeCompare(b.id ?? b.path),
  );
  return sorted.map((c) => {
    const errors = [...c.errors];
    const m = c.manifest;
    const prefix = m?.contributes.configuration?.prefix;
    if (m && prefix) {
      const owner = prefixes.get(prefix);
      if (owner && owner !== m.id) errors.push(`configuration prefix "${prefix}" is already used by ${owner}`);
      else prefixes.set(prefix, m.id);
    }
    let state: PluginDescriptor['state'];
    if (!m || errors.length > 0) state = 'invalid';
    else if (!isEngineCompatible(m.engine, apiVersion)) state = 'incompatible';
    else {
      const flag = enabled[m.id];
      state = flag === false || (flag === undefined && c.source === 'user') ? 'disabled' : 'enabled';
    }
    if (state === 'incompatible' && m)
      errors.push(`requires Oxytocin API ${m.engine} (this version provides ${apiVersion})`);
    return {
      id: c.id ?? c.path,
      version: c.version,
      displayName: m?.displayName ?? c.id ?? c.path,
      ...(m?.description ? { description: m.description } : {}),
      ...(m?.publisher ? { publisher: m.publisher } : {}),
      source: c.source,
      path: c.path,
      state,
      ...(errors.length > 0 ? { errors } : {}),
      ...(c.shadowed.length > 0 ? { shadowed: c.shadowed.map((s) => ({ source: s.source, path: s.path })) } : {}),
      ...(m ? { manifest: m } : {}),
    };
  });
}

export const EMPTY_CONTRIBUTIONS: Contributions = {
  views: [],
  panels: [],
  statusBarItems: [],
  commands: [],
  configuration: [],
  fileOpeners: [],
  terminalProfiles: [],
  agents: [],
};

/** Contributions of usable plugins (enabled or active). */
export function collectContributions(plugins: readonly PluginDescriptor[]): Contributions {
  const out: Contributions = structuredClone(EMPTY_CONTRIBUTIONS);
  for (const p of plugins) {
    if ((p.state !== 'enabled' && p.state !== 'active') || !p.manifest) continue;
    const c = p.manifest.contributes;
    const pluginId = p.id;
    out.views.push(...c.views.map((v) => ({ ...v, pluginId })));
    out.panels.push(...c.panels.map((v) => ({ ...v, pluginId })));
    out.statusBarItems.push(...c.statusBarItems.map((v) => ({ ...v, pluginId })));
    out.commands.push(...c.commands.map((v) => ({ ...v, pluginId })));
    if (c.configuration) out.configuration.push({ ...c.configuration, pluginId });
    out.fileOpeners.push(...c.fileOpeners.map((v) => ({ ...v, pluginId })));
    out.terminalProfiles.push(...c.terminalProfiles.map((v) => ({ ...v, pluginId })));
    out.agents.push(...c.agents.map((v) => ({ ...v, pluginId })));
  }
  out.views.sort((a, b) => a.order - b.order);
  return out;
}
