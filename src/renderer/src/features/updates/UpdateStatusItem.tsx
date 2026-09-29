import { AlertTriangle, ArrowDownCircle, RefreshCw } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/Button';
import { ProgressBar } from '../../ui/ProgressBar';
import { updatePanelView, updateStatusView } from './update-model';
import { checkForUpdates, restartToUpdate, retryUpdate, setUpdatePanelOpen, useUpdateStore } from './update-store';

/**
 * Right side of the status bar: the app version, download progress, "Restart to update" or a failed download.
 * While an update downloads, is ready or failed, a click opens a popover with the progress and the choices.
 */
export function UpdateStatusItem() {
  const state = useUpdateStore((s) => s.state);
  const open = useUpdateStore((s) => s.panelOpen);
  // "checked 5 min ago" is computed when the pointer enters (the tooltip), not on every render.
  const [now, setNow] = useState(() => Date.now());
  if (!state) return null;
  const view = updateStatusView(state, now);
  const hasPanel = view.kind !== 'version';
  return (
    <Popover.Root open={open} onOpenChange={setUpdatePanelOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="status-update"
          data-kind={view.kind}
          title={open ? undefined : view.title}
          onPointerEnter={() => setNow(Date.now())}
          className={cn(
            'flex items-center gap-1 hover:text-fg',
            view.kind === 'ready' && 'font-medium text-accent',
            view.kind === 'failed' && 'text-danger',
            view.kind === 'version' && 'font-mono text-fg-muted',
          )}
          onClick={(e) => {
            // The version alone has no popover: a click checks for updates (a found update opens the popover).
            if (hasPanel) return;
            e.preventDefault();
            void checkForUpdates();
          }}
        >
          {view.kind === 'ready' && <RefreshCw size={12} />}
          {view.kind === 'progress' && <ArrowDownCircle size={12} />}
          {view.kind === 'failed' && <AlertTriangle size={12} />}
          <span>{view.text}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-testid="update-panel"
          aria-label="Update"
          className="z-50 w-80 rounded-card border border-line bg-elevated p-3 text-fg shadow-elevated"
        >
          <UpdatePanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UpdatePanel() {
  const state = useUpdateStore((s) => s.state);
  if (!state) return null;
  const view = updatePanelView(state);
  const close = () => setUpdatePanelOpen(false);
  return (
    <div className="flex flex-col gap-2" data-tone={view.tone}>
      <div
        data-testid="update-panel-title"
        className={cn('font-medium', view.tone === 'error' && 'text-danger', view.tone === 'success' && 'text-accent')}
      >
        {view.title}
      </div>
      {view.description && (
        <div data-testid="update-panel-description" className="text-small break-words text-fg-secondary select-text">
          {view.description}
        </div>
      )}
      {view.percent !== undefined && (
        <div className="flex flex-col gap-1">
          <ProgressBar value={view.percent / 100} warnAt={2} dangerAt={2} label="Download progress" />
          <div className="flex justify-between text-small text-fg-muted">
            <span data-testid="update-panel-percent" className="font-mono">
              {view.percent}%
            </span>
            {view.detail && <span className="font-mono">{view.detail}</span>}
          </div>
        </div>
      )}
      {view.actions.length > 0 && (
        <div className="mt-1 flex justify-end gap-2">
          {view.actions.includes('retry') && (
            <Button size="sm" variant="primary" onClick={() => void retryUpdate()}>
              Retry
            </Button>
          )}
          {view.actions.includes('install-on-quit') && (
            <Button size="sm" onClick={close} title="The update installs the next time you quit Oxytocin.">
              On restart
            </Button>
          )}
          {view.actions.includes('install-now') && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                close();
                void restartToUpdate();
              }}
            >
              Install now
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
