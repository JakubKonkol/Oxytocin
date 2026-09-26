import { Bell, BellOff } from 'lucide-react';
import { ipc } from '../../lib/ipc-client';
import { activeProject, useProjectsStore } from '../../stores/projects-store';
import { useSettingsStore } from '../../stores/settings-store';
import { IconButton } from '../../ui/IconButton';
import { jumpToWaitingAgent } from './attention';
import { useWaitingCount } from './attention-badge';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Left side of the status bar: the active project's terminals and agents (docs/plan/02-ui-ux.md §5). */
export function ActivityStatusItems() {
  const project = useProjectsStore(activeProject);
  const status = useProjectsStore((s) => (s.activeId ? s.activity[s.activeId] : undefined));
  const waitingAll = useWaitingCount();
  if (!project) return <span>No project</span>;
  const working = status?.agents.working ?? 0;
  return (
    <>
      <span data-testid="status-terminals">{plural(status?.terminals ?? 0, 'terminal')}</span>
      {working > 0 && (
        <span data-testid="status-agents-working" className="text-agent">
          {working} agent{working === 1 ? '' : 's'} working
        </span>
      )}
      {waitingAll > 0 && (
        <button
          type="button"
          data-testid="status-agents-waiting"
          className="text-warning hover:underline"
          title="Jump to waiting agent (Ctrl+Shift+J)"
          onClick={() => void jumpToWaitingAgent()}
        >
          {waitingAll} waiting
        </button>
      )}
    </>
  );
}

/** Do-not-disturb toggle: mutes OS notifications. */
export function NotificationsToggle() {
  const dnd = useSettingsStore((s) => s.settings?.['notifications.doNotDisturb'] ?? false);
  return (
    <IconButton
      data-testid="status-dnd"
      label={
        dnd ? 'Do not disturb is on — click to allow notifications' : 'Notifications on — click for do not disturb'
      }
      icon={dnd ? <BellOff size={13} /> : <Bell size={13} />}
      active={dnd}
      className="size-5"
      onClick={() => void ipc.invoke('settings:update', { 'notifications.doNotDisturb': !dnd })}
    />
  );
}
