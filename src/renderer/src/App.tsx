import { useEffect, useState } from 'react';
import { useUiStore } from './stores/ui-store';
import { AppLayout } from './shell/AppLayout';
import { Toaster } from './ui/Toast';
import { TooltipProvider } from './ui/Tooltip';

export function App() {
  const loaded = useUiStore((s) => s.loaded);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    useUiStore
      .getState()
      .load()
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
    </TooltipProvider>
  );
}
