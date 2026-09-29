import { registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { usePluginsStore } from '../../stores/plugins-store';
import { notify } from '../../ui/Toast';
import { currentPlatform } from '../../lib/platform';
import { useUiStore } from '../../stores/ui-store';
import { workspaceFor } from '../attention/reveal';
import { isInsideRoot } from '../terminals/file-links';
import { revealSidebarTool } from '../tools/tools';
import { openPluginPanel, type PluginPanelParams } from './plugin-panels';
import { postToView } from './view-bridge';

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

/** A file position from a terminal link (`src/app.ts:42:7`). */
export interface FilePosition {
  line?: number;
  column?: number;
}

const caseInsensitivePaths = () => currentPlatform() !== 'linux';
const samePath = (a: unknown, b: string) =>
  typeof a === 'string' && isInsideRoot(a, b, caseInsensitivePaths()) && isInsideRoot(b, a, caseInsensitivePaths());
const pathParam = (params: unknown) => (params as { path?: unknown } | undefined)?.path;

/**
 * Opens a file with a plugin opener: its panel type with `{ projectId, path, line?, column? }` (absolute path). A
 * panel of that type already showing the file (in the workspace or a sidebar) is revealed instead, and its
 * view receives `{ type: 'oxy:reveal', line, column }` for the new position.
 */
export async function openWithOpener(
  opener: { panelType: string },
  projectId: string,
  absolutePath: string,
  position: FilePosition = {},
): Promise<void> {
  const reveal = (viewId: string) => {
    if (position.line) requestAnimationFrame(() => postToView(viewId, { type: 'oxy:reveal', ...position }));
  };
  const { secondaryTools, primaryTools } = useUiStore.getState().state;
  const tool = [...secondaryTools, ...primaryTools].find(
    (t) => t.kind === 'plugin' && t.panelType === opener.panelType && samePath(pathParam(t.params), absolutePath),
  );
  if (tool?.kind === 'plugin') {
    revealSidebarTool(tool.id);
    reveal(tool.viewId);
    return;
  }
  const api = await workspaceFor(projectId);
  const panel = api?.panels.find((p) => {
    const params = p.params as Partial<PluginPanelParams> | undefined;
    return (
      p.api.component === 'plugin' &&
      params?.panelType === opener.panelType &&
      samePath(pathParam(params.params), absolutePath)
    );
  });
  if (panel) {
    panel.api.setActive();
    reveal((panel.params as PluginPanelParams).viewId);
    return;
  }
  const at = {
    ...(position.line ? { line: position.line } : {}),
    ...(position.column ? { column: position.column } : {}),
  };
  await openPluginPanel(opener.panelType, { projectId, params: { projectId, path: absolutePath, ...at } });
}
