import { Bell, BellOff, GitBranch } from 'lucide-react';
import { executeCommand } from '../../lib/commands';
import { useChangesStore } from '../../stores/changes-store';
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
  const git = useChangesStore((s) => (project ? s.status[project.id] : undefined));
  if (!project) return <span>No project</span>;
  const working = status?.agents.working ?? 0;
  const branch = git?.branch;
  return (
    <>
      {git?.state === 'ok' && (
        <button
          type="button"
          data-testid="status-git"
          className="flex items-center gap-1 hover:text-fg"
          title="Focus changes (Ctrl+Shift+G)"
          onClick={() => void executeCommand('workbench.focusChanges')}
        >
          <GitBranch size={12} />
          <span>
            {branch?.detached ? branch.oid?.slice(0, 7) : (branch?.head ?? '—')}
            {branch && branch.ahead > 0 ? ` ↑${branch.ahead}` : ''}
            {branch && branch.behind > 0 ? ` ↓${branch.behind}` : ''}
          </span>
          <span>· {plural(git.totals.files, 'change')}</span>
        </button>
      )}
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
