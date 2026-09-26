import { useEffect, useState } from 'react';
import { useAppStore } from './stores/app-store';
import { subscribeSettings, useSettingsStore } from './stores/settings-store';
import { subscribeTerminals, useTerminalsStore } from './stores/terminals-store';
import { useUiStore } from './stores/ui-store';
import { subscribeProjects, useProjectsStore } from './stores/projects-store';
import { subscribeChanges } from './stores/changes-store';
import { showNotification } from './features/attention/attention';
import { revealTerminal } from './features/attention/reveal';
import { ipc } from './lib/ipc-client';
import { AppLayout } from './shell/AppLayout';
import { Toaster } from './ui/Toast';
import { DialogHost } from './ui/DialogHost';
import { ProfilePicker } from './features/layout/ProfilePicker';
import { TooltipProvider } from './ui/Tooltip';

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subscribeSettings();
    subscribeChanges();
    subscribeTerminals();
    subscribeProjects();
    ipc.on('notifications:show', showNotification);
    ipc.on('terminals:reveal', ({ projectId, terminalId }) => void revealTerminal(projectId, terminalId));
    Promise.all([
      useUiStore.getState().load(),
      useSettingsStore.getState().load(),
      useAppStore.getState().load(),
      useTerminalsStore.getState().load(),
      useProjectsStore.getState().load(),
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
      <ProfilePicker />
    </TooltipProvider>
  );
}
