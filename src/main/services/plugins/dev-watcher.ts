import { type FSWatcher, watch as fsWatch } from 'node:fs';
import type { PluginDescriptor } from '@shared/domain/plugin';
import type { Logger } from '@shared/logging/logger';

const DEBOUNCE_MS = 300;
/** Sources and dependencies do not affect the loaded plugin until it is rebuilt into its shipped files. */
const IGNORED = /^(node_modules|\.git|src)([\\/]|$)/;

export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => Pick<FSWatcher, 'close' | 'on'>;

/**
 * Developer mode: watches the folders of plugins loaded from `plugins.devPaths`
 * and reloads a plugin 300 ms after its files stop changing.
 */
export class DevPluginWatcher {
  private readonly watchers = new Map<string, { path: string; watcher: Pick<FSWatcher, 'close'> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly reload: (id: string) => void,
    private readonly logger: Logger,
    private readonly watch: WatchFn = (path, options, listener) =>
      fsWatch(path, options, (event, filename) => listener(event, filename?.toString() ?? null)),
  ) {}

  /** Syncs the watched folders with the current dev plugins. */
  update(plugins: PluginDescriptor[], enabled: boolean): void {
    const wanted = new Map(
      enabled ? plugins.filter((p) => p.source === 'dev').map((p) => [p.id, p.path] as const) : [],
    );
    for (const [id, w] of [...this.watchers]) {
      if (wanted.get(id) !== w.path) this.stop(id);
    }
    for (const [id, path] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const watcher = this.watch(path, { recursive: true }, (_event, filename) => {
          if (filename && IGNORED.test(filename)) return;
          this.schedule(id);
        });
        watcher.on('error', (e: unknown) => this.logger.warn(`Watching plugin ${id} failed`, e));
        this.watchers.set(id, { path, watcher });
      } catch (e) {
        this.logger.warn(`Cannot watch plugin ${id} in ${path}`, e);
      }
    }
  }

  private schedule(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.logger.info(`Plugin ${id} changed on disk — reloading`);
        this.reload(id);
      }, DEBOUNCE_MS),
    );
  }

  private stop(id: string): void {
    this.watchers.get(id)?.watcher.close();
    this.watchers.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id);
  }
}
