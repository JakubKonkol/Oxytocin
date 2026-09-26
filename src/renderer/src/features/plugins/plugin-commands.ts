import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { usePluginsStore } from '../../stores/plugins-store';
import { notify } from '../../ui/Toast';
import { openPluginPanel } from './plugin-panels';

const registered = new Map<string, () => void>();

/** Keeps plugin commands (`contributes.commands`) in the core command registry (palette, keybindings, menus). */
export function syncPluginCommands(): void {
  const apply = () => {
    const commands = usePluginsStore.getState().contributions.commands;
    const wanted = new Set(commands.map((c) => c.id));
    for (const [id, dispose] of [...registered]) {
      if (!wanted.has(id)) {
        dispose();
        registered.delete(id);
      }
    }
    for (const c of commands) {
      if (registered.has(c.id)) continue;
      registered.set(
        c.id,
        registerCommand({
          id: c.id,
          title: c.title,
          run: async (...args: unknown[]) => {
            try {
              return await ipc.invoke('plugins:executeCommand', { id: c.id, args });
            } catch (e) {
              notify('error', `${c.title} failed`, { description: e instanceof Error ? e.message : String(e) });
              return undefined;
            }
          },
        }),
      );
    }
  };
  apply();
  usePluginsStore.subscribe((s, prev) => {
    if (s.contributions.commands !== prev.contributions.commands) apply();
  });
  ipc.on('plugins:openPanel', ({ panelType, ...o }) => {
    void openPluginPanel(panelType, o as never).catch((e: unknown) =>
      notify('error', 'Could not open the panel', { description: e instanceof Error ? e.message : String(e) }),
    );
  });
}

/** File openers (`contributes.fileOpeners`) matching a path's extension. */
export function fileOpenersFor(path: string) {
  const lower = path.toLowerCase();
  return usePluginsStore
    .getState()
    .contributions.fileOpeners.filter((o) => o.extensions.some((ext) => lower.endsWith(ext.toLowerCase())));
}

/** Opens a file with a plugin opener: its panel type with `{ projectId, path }` (absolute path). */
export function openWithOpener(opener: { panelType: string }, projectId: string, absolutePath: string): Promise<void> {
  return openPluginPanel(opener.panelType, { projectId, params: { projectId, path: absolutePath } });
}
