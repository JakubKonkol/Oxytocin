import { ContextMenu } from 'radix-ui';
import { AlertTriangle, Pin } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Project } from '@shared/domain/project';
import type { TerminalInfo } from '@shared/domain/terminal';
import { cn } from '../../lib/cn';
import { executeCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { Badge } from '../../ui/Badge';
import { PROJECT_ACTIVITY_LABELS } from '@shared/domain/activity';
import { StatusDot } from '../../ui/StatusDot';
import { useProjectsStore } from '../../stores/projects-store';
import { activateProject, removeProject, renameProject } from './project-actions';
import { openProjectSettings } from './ProjectSettingsDialog';
import { ProjectAvatar } from './ProjectAvatar';

export const PROJECT_DRAG_TYPE = 'application/x-oxytocin-project';

export interface ProjectItemProps {
  project: Project;
  active: boolean;
  terminals: readonly TerminalInfo[];
  onDragStart: (id: string) => void;
  onDropOn: (targetId: string, after: boolean) => void;
}

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';

/** One row of the PROJECTS list. */
export function ProjectItem({ project, active, terminals, onDragStart, onDropOn }: ProjectItemProps) {
  const [renaming, setRenaming] = useState(false);
  // Rename chosen from the context menu: start it once the menu has closed and handed focus back, otherwise the
  // menu's focus restore blurs the fresh input and ends the rename immediately.
  const renameAfterMenu = useRef(false);
  const [dropHint, setDropHint] = useState<'before' | 'after' | null>(null);
  const status = useProjectsStore((s) => s.activity[project.id]);
  const dot = status?.activity ?? 'none';
  const waiting = status?.agents.waiting ?? 0;
  const reveal = currentPlatform() === 'darwin' ? 'Reveal in Finder' : 'Reveal in Explorer';
  const tooltip = [
    project.rootPath,
    project.missing
      ? 'Folder not found'
      : dot === 'attention'
        ? `${waiting} agent${waiting === 1 ? ' is' : 's are'} waiting for you`
        : dot === 'error' && status?.unseenError
          ? `Process exited with code ${status.unseenError.exitCode}`
          : PROJECT_ACTIVITY_LABELS[dot],
    `${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="option"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={tooltip}
          data-testid={`projects-item-${project.name}`}
          data-project-id={project.id}
          draggable={!renaming}
          className={cn(
            'relative flex h-8 cursor-default items-center gap-2 rounded-control pr-2 pl-2 outline-none select-none',
            active ? 'bg-card-hover font-semibold text-fg' : 'text-fg-secondary hover:bg-card-hover',
            project.missing && 'opacity-60',
            'focus-visible:ring-2 focus-visible:ring-line-focus',
          )}
          onClick={() => activateProject(project.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateProject(project.id);
            } else if (e.key === 'F2') {
              e.preventDefault();
              setRenaming(true);
            }
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
            e.dataTransfer.effectAllowed = 'move';
            onDragStart(project.id);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            setDropHint(e.clientY > rect.top + rect.height / 2 ? 'after' : 'before');
          }}
          onDragLeave={() => setDropHint(null)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            onDropOn(project.id, dropHint === 'after');
            setDropHint(null);
          }}
        >
          {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-line-focus" />}
          {dropHint && (
            <span
              className={cn('absolute inset-x-1 h-0.5 bg-accent', dropHint === 'before' ? '-top-px' : '-bottom-px')}
            />
          )}
          <StatusDot state={dot} size={7} testId={`status-dot-${project.id}`} />
          <ProjectAvatar project={project} />
          {renaming ? (
            <input
              // Explicit rename action: focus the field.
              autoFocus
              aria-label="Project name"
              data-testid="project-rename-input"
              defaultValue={project.name}
              className="h-6 min-w-0 flex-1 rounded-badge border border-line-focus bg-input px-1 text-ui text-fg outline-none"
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  void renameProject(project.id, e.currentTarget.value);
                  setRenaming(false);
                } else if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={(e) => {
                void renameProject(project.id, e.currentTarget.value);
                setRenaming(false);
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              {project.name}
            </span>
          )}
          {project.pinned && <Pin aria-label="Pinned" size={11} className="flex-none text-fg-muted" />}
          {project.missing ? (
            <AlertTriangle aria-label="Folder not found" size={13} className="flex-none text-warning" />
          ) : (
            active && <Badge variant="active">ACTIVE</Badge>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-testid="project-context-menu"
          className="z-50 min-w-52 rounded-control border border-line bg-elevated p-1 shadow-elevated"
          onCloseAutoFocus={(e) => {
            if (!renameAfterMenu.current) return;
            renameAfterMenu.current = false;
            e.preventDefault();
            setRenaming(true);
          }}
        >
          <ContextMenu.Item className={menuItem} onSelect={() => activateProject(project.id)}>
            Open
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            disabled={project.missing === true}
            onSelect={() => void executeCommand('projects.newTerminal', project.id)}
          >
            New terminal in project
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item
            className={menuItem}
            data-testid="project-menu-rename"
            onSelect={() => {
              renameAfterMenu.current = true;
            }}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => void ipc.invoke('projects:update', { id: project.id, pinned: !project.pinned })}
          >
            {project.pinned ? 'Unpin' : 'Pin'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item
            className={menuItem}
            disabled={project.missing === true}
            onSelect={() => void ipc.invoke('shell:revealInFolder', { path: project.rootPath })}
          >
            {reveal}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            onSelect={() => void ipc.invoke('clipboard:writeText', { text: project.rootPath })}
          >
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItem}
            data-testid="project-menu-settings"
            onSelect={() => setTimeout(() => openProjectSettings(project.id), 0)}
          >
            Project settings…
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-line-subtle" />
          <ContextMenu.Item className={cn(menuItem, 'text-danger')} onSelect={() => void removeProject(project)}>
            Remove from Oxytocin…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
