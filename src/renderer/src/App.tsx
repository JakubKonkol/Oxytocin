import { useEffect, useState } from 'react';
import { useAppStore } from './stores/app-store';
import { subscribeSettings, useSettingsStore } from './stores/settings-store';
import { subscribeTerminals, useTerminalsStore } from './stores/terminals-store';
import { useUiStore } from './stores/ui-store';
import { subscribeProjects, useProjectsStore } from './stores/projects-store';
import { subscribeChanges } from './stores/changes-store';
import { subscribePlugins, usePluginsStore } from './stores/plugins-store';
import { subscribeKeybindings, useKeybindingsStore } from './features/keybindings/keybindings-store';
import { ViewContextMenuHost } from './features/plugins/view-context-menu';
import { AppLayout } from './shell/AppLayout';
import { subscribeShellEvents } from './shell/shell-events';
import { Toaster } from './ui/Toast';
import { DialogHost } from './ui/DialogHost';
import { ProfilePicker } from './features/layout/ProfilePicker';
import { CommandPalette } from './features/palette/CommandPalette';
import { ProjectSettingsDialog } from './features/projects/ProjectSettingsDialog';
import { reportSettingsProblems } from './features/settings/SettingsPanel';
import { PluginConsentDialog } from './features/plugins/PluginConsentDialog';
import { subscribeUpdates } from './features/updates/update-store';
import { TooltipProvider } from './ui/Tooltip';
import { subscribeMcp } from './features/agent-tools/mcp-store';

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subscribeSettings();
    subscribeChanges();
    subscribePlugins();
    subscribeTerminals();
    subscribeProjects();
    subscribeKeybindings();
    subscribeUpdates();
    subscribeMcp();
    const unsubscribe = subscribeShellEvents();
    let mounted = true;
    Promise.all([
      useUiStore.getState().load(),
      useSettingsStore.getState().load(),
      useAppStore.getState().load(),
      useTerminalsStore.getState().load(),
      useProjectsStore.getState().load(),
      usePluginsStore.getState().load(),
      useKeybindingsStore.getState().load(),
    ])
      .then(() => {
        if (!mounted) return;
        setLoaded(true);
        void reportSettingsProblems();
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
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
      <PluginConsentDialog />
      <ViewContextMenuHost />
      <ProfilePicker />
      <CommandPalette />
      <ProjectSettingsDialog />
    </TooltipProvider>
  );
}
