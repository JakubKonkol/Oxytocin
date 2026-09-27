import type { IDockviewPanelProps } from 'dockview-react';
import {
  Bug,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FolderOpen,
  FolderPlus,
  Puzzle,
  RotateCw,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { PluginDescriptor } from '@shared/domain/plugin';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { usePluginsStore } from '../../stores/plugins-store';
import { useSettingsStore } from '../../stores/settings-store';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { notify } from '../../ui/Toast';
import { confirmDialog } from '../../stores/dialog-store';
import { needsConsent } from './consent-model';
import { requestPluginConsent } from './PluginConsentDialog';

type LogEntry = { at: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

const STATE_VARIANT: Record<PluginDescriptor['state'], BadgeVariant> = {
  active: 'process',
  enabled: 'neutral',
  disabled: 'shell',
  failed: 'danger',
  invalid: 'danger',
  incompatible: 'warning',
};
const SOURCE_LABEL: Record<PluginDescriptor['source'], string> = { builtin: 'built-in', user: 'user', dev: 'dev' };
const LOG_REFRESH_MS = 2000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function run(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (e) {
    notify('error', label, { description: errorText(e) });
  }
}

/** Enables a plugin; one the user installed runs only after they agree to its permissions. */
async function enablePlugin(plugin: PluginDescriptor): Promise<boolean> {
  const settings = await ipc.invoke('settings:get');
  if (needsConsent(plugin, settings['plugins.enabled']) && !(await requestPluginConsent(plugin))) return false;
  await ipc.invoke('plugins:setEnabled', { id: plugin.id, enabled: true });
  return true;
}

/** "Install from folder…" / "Install from .zip…" (M9-T3). */
function installPlugin(kind: 'folder' | 'zip'): void {
  void run('Could not install the plugin', async () => {
    const installed = await ipc.invoke('plugins:install', { kind });
    if (!installed) return;
    const plugin = (await ipc.invoke('plugins:list')).find((p) => p.id === installed.id && p.source === 'user');
    const verb = installed.replaced ? 'Updated' : 'Installed';
    if (
      plugin &&
      plugin.state === 'disabled' &&
      needsConsent(plugin, (await ipc.invoke('settings:get'))['plugins.enabled'])
    ) {
      if (await enablePlugin(plugin)) notify('success', `${verb} and enabled ${installed.displayName}`);
      else
        notify('info', `${verb} ${installed.displayName}`, { description: 'It stays disabled until you enable it.' });
      return;
    }
    notify('success', `${verb} ${installed.displayName} ${installed.version}`);
  });
}

async function uninstallPlugin(plugin: PluginDescriptor): Promise<void> {
  const ok = await confirmDialog({
    title: `Uninstall ${plugin.displayName}?`,
    description: 'Its files are removed from the plugins folder. Its settings stay in settings.json.',
    confirmLabel: 'Uninstall',
    destructive: true,
  });
  if (!ok) return;
  await run(`Could not uninstall ${plugin.displayName}`, async () => {
    await ipc.invoke('plugins:uninstall', { id: plugin.id });
    notify('success', `Uninstalled ${plugin.displayName}`);
  });
}

function PluginLogs({ id }: { id: string }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const load = useCallback(() => {
    ipc.invoke('plugins:logs', { id }).then(setEntries, () => setEntries([]));
  }, [id]);
  useEffect(() => {
    load();
    const timer = setInterval(load, LOG_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  if (!entries) return <div className="px-3 py-2 text-small text-fg-muted">Loading logs…</div>;
  if (entries.length === 0) return <div className="px-3 py-2 text-small text-fg-muted">No log entries yet.</div>;
  return (
    <div
      data-testid="plugin-logs"
      className="max-h-64 overflow-auto rounded-control border border-line-subtle bg-input px-3 py-2 font-mono text-small"
    >
      {entries.map((e, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap',
            e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warning' : 'text-fg-secondary',
          )}
        >
          <span className="text-fg-muted">{new Date(e.at).toLocaleTimeString()} </span>
          {e.level.toUpperCase().padEnd(5)} {e.message}
        </div>
      ))}
    </div>
  );
}

function PluginRow({ plugin, developerMode }: { plugin: PluginDescriptor; developerMode: boolean }) {
  const [showLogs, setShowLogs] = useState(false);
  const toggleable = plugin.state !== 'invalid' && plugin.state !== 'incompatible';
  const enabled = plugin.state === 'enabled' || plugin.state === 'active' || plugin.state === 'failed';
  const permissions = plugin.manifest?.permissions ?? [];
  const sep = plugin.path.includes('\\') ? '\\' : '/';
  return (
    <li
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
      data-state={plugin.state}
      className="border-b border-line-subtle px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <Puzzle size={18} className="mt-0.5 flex-none text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{plugin.displayName}</span>
            <span className="font-mono text-small text-fg-muted">
              {plugin.id} · v{plugin.version}
            </span>
            <Badge variant="neutral">{SOURCE_LABEL[plugin.source]}</Badge>
            <Badge variant={STATE_VARIANT[plugin.state]} testId="plugin-state">
              {plugin.state}
            </Badge>
          </div>
          {plugin.description && <div className="mt-1 text-fg-secondary">{plugin.description}</div>}
          {permissions.length > 0 && (
            <div className="mt-1 text-small text-fg-muted">Permissions: {permissions.join(', ')}</div>
          )}
          {(plugin.errors ?? []).map((error, i) => (
            <div key={i} data-testid="plugin-error" className="mt-1 text-small text-danger">
              {error}
            </div>
          ))}
        </div>
        <div className="flex flex-none items-center gap-1">
          {toggleable && (
            <Button
              size="sm"
              variant={enabled ? 'secondary' : 'primary'}
              onClick={() =>
                void run(`Could not ${enabled ? 'disable' : 'enable'} ${plugin.displayName}`, () =>
                  enabled ? ipc.invoke('plugins:setEnabled', { id: plugin.id, enabled: false }) : enablePlugin(plugin),
                )
              }
            >
              {enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          {enabled && (
            <Button
              size="sm"
              variant="ghost"
              title="Reload the plugin and its views"
              onClick={() =>
                void run(`Could not reload ${plugin.displayName}`, () =>
                  ipc.invoke('plugins:reload', { id: plugin.id }),
                )
              }
            >
              <RotateCw size={12} /> Reload
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-expanded={showLogs} onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ScrollText size={12} /> Show logs
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={plugin.path}
            onClick={() => void ipc.invoke('shell:revealInFolder', { path: `${plugin.path}${sep}package.json` })}
          >
            <FolderOpen size={12} /> Open folder
          </Button>
          {plugin.source === 'user' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="plugin-uninstall"
              title="Remove the plugin"
              onClick={() => void uninstallPlugin(plugin)}
            >
              <Trash2 size={12} /> Uninstall
            </Button>
          )}
          {plugin.source === 'dev' && developerMode && (
            <Button
              size="sm"
              variant="ghost"
              title="Remove from the developer folders"
              aria-label="Remove"
              onClick={() =>
                void run('Could not remove the folder', () =>
                  ipc.invoke('plugins:removeDevPath', { path: plugin.path }),
                )
              }
            >
              <X size={12} />
            </Button>
          )}
        </div>
      </div>
      {showLogs && (
        <div className="mt-2 pl-8">
          <PluginLogs id={plugin.id} />
        </div>
      )}
    </li>
  );
}

/** Minimal plugin manager (docs/plan/07-plugin-engine.md §5, roadmap M5-T7). */
export function PluginsPanel(_props: IDockviewPanelProps) {
  const plugins = usePluginsStore((s) => s.plugins);
  const developerMode = useSettingsStore((s) => s.settings?.['plugins.developerMode'] ?? false);
  const loadFromFolder = () =>
    void run('Could not load the plugin', async () => {
      const result = await ipc.invoke('plugins:loadFromFolder');
      if (!result) return;
      if (!result.id || result.errors.length > 0)
        notify('warning', 'The plugin could not be loaded', { description: result.errors.join('\n') });
      else notify('success', `Loaded ${result.id} from ${result.path}`);
    });
  const sorted = [...plugins].sort(
    (a, b) =>
      Number(a.source !== 'builtin') - Number(b.source !== 'builtin') || a.displayName.localeCompare(b.displayName),
  );
  return (
    <div data-testid="plugins-panel" className="flex h-full min-h-0 flex-col bg-card text-ui">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-line-subtle px-4">
        <span className="font-medium text-fg">Plugins</span>
        <span className="text-small text-fg-muted">{plugins.length}</span>
        <span className="flex-1" />
        <Button size="sm" data-testid="plugins-install-folder" onClick={() => installPlugin('folder')}>
          <FolderPlus size={12} /> Install from folder…
        </Button>
        <Button size="sm" data-testid="plugins-install-zip" onClick={() => installPlugin('zip')}>
          <FileArchive size={12} /> Install from .zip…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Open the folder of installed plugins"
          onClick={() => void ipc.invoke('plugins:openUserFolder')}
        >
          <FolderOpen size={12} /> Plugins folder
        </Button>
        <label className="flex items-center gap-1.5 text-small text-fg-secondary">
          <input
            type="checkbox"
            data-testid="plugins-developer-mode"
            checked={developerMode}
            onChange={(e) => void ipc.invoke('settings:update', { 'plugins.developerMode': e.target.checked })}
          />
          Developer mode
        </label>
        {developerMode && (
          <>
            <Button size="sm" onClick={loadFromFolder}>
              <FolderPlus size={12} /> Load plugin from folder…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void ipc.invoke('plugins:openDevTools')}>
              <Bug size={12} /> Open DevTools
            </Button>
          </>
        )}
      </div>
      {sorted.length === 0 ? (
        <EmptyState title="No plugins found" />
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {sorted.map((p) => (
            <PluginRow key={`${p.source}:${p.id}:${p.path}`} plugin={p} developerMode={developerMode} />
          ))}
        </ul>
      )}
    </div>
  );
}
