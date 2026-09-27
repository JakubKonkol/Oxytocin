import { useEffect, useState } from 'react';
import { useAppStore } from './stores/app-store';
import { subscribeSettings, useSettingsStore } from './stores/settings-store';
import { subscribeTerminals, useTerminalsStore } from './stores/terminals-store';
import { useUiStore } from './stores/ui-store';
import { subscribeProjects, useProjectsStore } from './stores/projects-store';
import { subscribeChanges } from './stores/changes-store';
import { subscribePlugins, usePluginsStore } from './stores/plugins-store';
import { ViewContextMenuHost } from './features/plugins/view-context-menu';
import { showNotification } from './features/attention/attention';
import { revealTerminal } from './features/attention/reveal';
import { openEditorInTerminal } from './features/layout/editor-terminal';
import { openPluginTerminal, runCoreCommand } from './features/layout/core-commands';
import { ipc } from './lib/ipc-client';
import { AppLayout } from './shell/AppLayout';
import { Toaster } from './ui/Toast';
import { DialogHost } from './ui/DialogHost';
import { ProfilePicker } from './features/layout/ProfilePicker';
import { CommandPalette } from './features/palette/CommandPalette';
import { TooltipProvider } from './ui/Tooltip';

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subscribeSettings();
    subscribeChanges();
    subscribePlugins();
    subscribeTerminals();
    subscribeProjects();
    ipc.on('notifications:show', showNotification);
    ipc.on('terminals:reveal', ({ projectId, terminalId }) => void revealTerminal(projectId, terminalId));
    ipc.on('editor:openInTerminal', (req) => void openEditorInTerminal(req));
    ipc.on('terminals:openPanel', (req) => void openPluginTerminal(req));
    ipc.on('commands:run', ({ id, args }) => runCoreCommand(id, args));
    Promise.all([
      useUiStore.getState().load(),
      useSettingsStore.getState().load(),
      useAppStore.getState().load(),
      useTerminalsStore.getState().load(),
      useProjectsStore.getState().load(),
      usePluginsStore.getState().load(),
    ])
      .then(() => setLoaded(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="p-4 text-danger">Failed to start: {error}</div>;
  if (!loaded) return null;
  return (
    <TooltipProvider>
      <div data-testid="app-ready" className="h-full">
        <AppLayout />
      </div>
      <Toaster />
      <DialogHost />
      <ViewContextMenuHost />
      <ProfilePicker />
      <CommandPalette />
    </TooltipProvider>
  );
}
