import { ArrowDownCircle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { updateStatusView } from './update-model';
import { checkForUpdates, restartToUpdate, useUpdateStore } from './update-store';

/** Right side of the status bar: the app version, download progress or "Restart to update" (02 §5). */
export function UpdateStatusItem() {
  const state = useUpdateStore((s) => s.state);
  // "checked 5 min ago" is computed when the pointer enters (the tooltip), not on every render.
  const [now, setNow] = useState(() => Date.now());
  if (!state) return null;
  const view = updateStatusView(state, now);
  return (
    <button
      type="button"
      data-testid="status-update"
      data-kind={view.kind}
      title={view.title}
      onPointerEnter={() => setNow(Date.now())}
      className={cn(
        'flex items-center gap-1 hover:text-fg',
        view.kind === 'ready' && 'font-medium text-accent',
        view.kind === 'version' && 'font-mono text-fg-muted',
      )}
      onClick={() => void (view.kind === 'ready' ? restartToUpdate() : checkForUpdates())}
    >
      {view.kind === 'ready' && <RefreshCw size={12} />}
      {view.kind === 'progress' && <ArrowDownCircle size={12} />}
      <span>{view.text}</span>
    </button>
  );
}
