import { access, readdir, readFile } from 'node:fs/promises';
import { OXYTOCIN_API_VERSION } from '@shared/constants';
import type { Contributions, PluginDescriptor, PluginState } from '@shared/domain/plugin';
import type { Settings } from '@shared/domain/settings';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { Emitter } from '@shared/utils/emitter';
import {
  type Candidate,
  collectContributions,
  describePlugins,
  type DiscoveryFs,
  readPlugin,
  resolveConflicts,
  scanDir,
} from './discovery';

export const nodeDiscoveryFs: DiscoveryFs = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, 'utf8'),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

export interface PluginServiceDeps {
  builtinDir: string;
  userDir: string;
  settings: () => Settings;
  updateSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  logger: Logger;
  fs?: DiscoveryFs;
  apiVersion?: string;
  /** Packaged builds: verify built-in plugins against their SHA-256 checksums. */
  verifyBuiltin?: (dir: string) => Promise<string[]>;
}

/** Discovery, enablement and runtime state of plugins (docs/plan/07-plugin-engine.md §5). */
export class PluginService {
  private plugins: PluginDescriptor[] = [];
  private runtime = new Map<string, { state: Extract<PluginState, 'active' | 'failed'>; error?: string }>();
  private readonly changeEmitter = new Emitter<PluginDescriptor[]>();
  readonly onDidChange = this.changeEmitter.event;
  private candidates: (Candidate & { shadowed: Candidate[] })[] = [];

  constructor(private readonly deps: PluginServiceDeps) {}

  private get fs(): DiscoveryFs {
    return this.deps.fs ?? nodeDiscoveryFs;
  }

  async scan(): Promise<PluginDescriptor[]> {
    const devPaths = this.deps.settings()['plugins.developerMode'] ? this.deps.settings()['plugins.devPaths'] : [];
    const found: Candidate[] = [
      ...(await scanDir(this.deps.builtinDir, 'builtin', this.fs)),
      ...(await scanDir(this.deps.userDir, 'user', this.fs)),
    ];
    for (const dir of devPaths) {
      const c = await readPlugin(dir, 'dev', this.fs).catch(() => null);
      if (c) found.push(c);
      else this.deps.logger.warn(`No plugin found in ${dir}`);
    }
    if (this.deps.verifyBuiltin) {
      for (const c of found) {
        if (c.source !== 'builtin' || c.errors.length > 0) continue;
        const problems = await this.deps.verifyBuiltin(c.path);
        if (problems.length > 0) c.errors.push(`integrity check failed: ${problems.slice(0, 3).join('; ')}`);
      }
    }
    this.candidates = resolveConflicts(found);
    this.recompute();
    for (const p of this.plugins) {
      if (p.state === 'invalid' || p.state === 'incompatible')
        this.deps.logger.warn(`Plugin ${p.id} is ${p.state}: ${(p.errors ?? []).join('; ')}`);
    }
    this.deps.logger.info(
      `Plugins: ${this.plugins.map((p) => `${p.id}@${p.version} (${p.source}, ${p.state})`).join(', ') || 'none'}`,
    );
    return this.plugins;
  }

  /** Re-derives states from settings and runtime (after `plugins.enabled` changes). */
  recompute(): void {
    const described = describePlugins(
      this.candidates,
      this.deps.settings()['plugins.enabled'],
      this.deps.apiVersion ?? OXYTOCIN_API_VERSION,
    );
    this.plugins = described.map((p) => {
      const rt = this.runtime.get(p.id);
      if (!rt || p.state !== 'enabled') return p;
      return { ...p, state: rt.state, ...(rt.error ? { errors: [...(p.errors ?? []), rt.error] } : {}) };
    });
    this.changeEmitter.fire(this.plugins);
  }

  list(): PluginDescriptor[] {
    return this.plugins;
  }

  get(id: string): PluginDescriptor | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  /** Plugins the Plugin Host should load. */
  enabled(): PluginDescriptor[] {
    return this.plugins.filter((p) => p.state === 'enabled' || p.state === 'active' || p.state === 'failed');
  }

  contributions(): Contributions {
    return collectContributions(this.plugins);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.get(id);
    if (!plugin) throw new OxyError('NOT_FOUND', `Plugin ${id} not found`);
    const current = this.deps.settings()['plugins.enabled'];
    await this.deps.updateSettings({ 'plugins.enabled': { ...current, [id]: enabled } });
    if (!enabled) this.runtime.delete(id);
    this.recompute();
  }

  /** Reported by the Plugin Host. */
  setRuntimeState(id: string, state: 'active' | 'failed' | 'inactive', error?: string): void {
    if (state === 'inactive') this.runtime.delete(id);
    else this.runtime.set(id, { state, ...(error ? { error } : {}) });
    this.recompute();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
