import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { Columns2, Maximize2, Minimize2, Rows2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { shortcutFor } from '../../lib/keyboard';
import { IconButton } from '../../ui/IconButton';
import { WorkspaceAddMenu } from '../tools/AddMenus';
import { splitActive, toggleMaximize } from './layout-commands';
import { getActiveWorkspace } from './workspace-registry';

const hint = (command: string) => shortcutFor(command);

/** Right side of a group header: split right, split down, maximize/restore, "+" (new terminal or tool). */
export function GroupActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group } = props;
  const [maximized, setMaximized] = useState(containerApi.hasMaximizedGroup());
  useEffect(() => {
    const d = containerApi.onDidMaximizedGroupChange(() => setMaximized(containerApi.hasMaximizedGroup()));
    return () => d.dispose();
  }, [containerApi]);

  const activate = () => {
    if (group.activePanel && !group.activePanel.api.isActive) group.activePanel.api.setActive();
  };
  const projectId = () => getActiveWorkspace()?.projectId;
  const split = (dir: 'right' | 'below') => {
    activate();
    const p = projectId();
    if (p) void splitActive(containerApi, p, dir);
  };
  const splitRight = hint('terminal.splitRight');
  const splitDown = hint('terminal.splitDown');
  const maximize = hint('panel.toggleMaximize');

  return (
    <div className="flex h-full items-center gap-0.5 pr-1.5" data-testid="group-actions">
      <IconButton
        label="Split right"
        {...(splitRight ? { shortcut: splitRight } : {})}
        icon={<Columns2 size={14} />}
        onClick={() => split('right')}
      />
      <IconButton
        label="Split down"
        {...(splitDown ? { shortcut: splitDown } : {})}
        icon={<Rows2 size={14} />}
        onClick={() => split('below')}
      />
      {(maximized || containerApi.groups.length > 1) && (
        <IconButton
          label={maximized ? 'Restore' : 'Maximize'}
          {...(maximize ? { shortcut: maximize } : {})}
          icon={maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          onClick={() => {
            activate();
            toggleMaximize(containerApi);
          }}
        />
      )}
      <WorkspaceAddMenu api={containerApi} group={group} projectId={projectId} onOpen={activate} />
    </div>
  );
}
