import { Puzzle } from 'lucide-react';
import { registerCommand } from '../../lib/commands';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { getActiveWorkspace } from '../layout/workspace-registry';

export const PLUGINS_PANEL_ID = 'plugins-manager';

/** Opens (or focuses) the Plugins panel in the active project's workspace. */
export function openPluginsManager(): void {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    notify('info', 'Open a project to manage plugins');
    return;
  }
  const existing = workspace.api.getPanel(PLUGINS_PANEL_ID);
  if (existing) {
    existing.api.setActive();
    return;
  }
  workspace.api.addPanel({ id: PLUGINS_PANEL_ID, component: 'plugins', title: 'Plugins' });
}

export function registerPluginManagerCommands(): void {
  registerCommand({ id: 'workbench.showPlugins', title: 'Plugins: Show Plugins', run: () => openPluginsManager() });
}

/** Status bar entry point until the command palette arrives (M7). */
export function PluginsStatusButton() {
  return (
    <IconButton
      data-testid="status-plugins"
      label="Plugins"
      icon={<Puzzle size={13} />}
      className="size-5"
      onClick={openPluginsManager}
    />
  );
}
