import { FolderX } from 'lucide-react';
import logoStacked from '../../assets/brand/logo-stacked-on-dark.svg';
import { useEffect, useState } from 'react';
import type { Project } from '@shared/domain/project';
import { useSettingsStore } from '../../stores/settings-store';
import { useWorkspacesStore } from '../../stores/workspaces-store';
import { cn } from '../../lib/cn';
import { activeProject, useProjectsStore } from '../../stores/projects-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { ProjectWorkspace } from '../layout/ProjectWorkspace';
import { addProjectViaDialog, locateProjectFolder, removeProject } from './project-actions';
import { addDroppedFolders } from './ProjectsSection';
import { hasUnsavedEdits } from '../layout/unsaved-registry';

/** First-run screen: add a project with the button, the shortcut or by dropping a folder. */
function Welcome() {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="welcome"
      className={cn(
        'flex h-full items-center justify-center rounded-card border border-line-subtle bg-card',
        over && 'border-accent bg-accent-muted/20',
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        void addDroppedFolders([...e.dataTransfer.files]);
      }}
    >
      <EmptyState
        icon={<img src={logoStacked} alt="Oxytocin" width={152} height={144} draggable={false} className="mb-4" />}
        title="Add your first project"
        description={
          <span>
            Pick a folder or drop it here. Shortcut: <Kbd shortcut="Ctrl+Shift+A" />
          </span>
        }
        actions={
          <Button variant="primary" onClick={() => void addProjectViaDialog()}>
            Add project
          </Button>
        }
      />
    </div>
  );
}

function MissingProject({ project }: { project: Project }) {
  return (
    <div
      data-testid="project-missing"
      className="flex h-full items-center justify-center rounded-card border border-line-subtle bg-card"
    >
      <EmptyState
        icon={<FolderX size={32} className="text-warning" />}
        title={`Folder not found: ${project.rootPath}`}
        actions={
          <>
            <Button variant="primary" onClick={() => void locateProjectFolder(project)}>
              Locate folder…
            </Button>
            <Button variant="secondary" onClick={() => void removeProject(project)}>
              Remove from list
            </Button>
          </>
        }
      />
    </div>
  );
}

/**
 * Center area. Workspaces of recently used projects stay mounted and are hidden with `display: none`
 * (keep-alive LRU, `workspace.keepAliveProjects`); evicted ones are rebuilt from the saved layout and the
 * PTY Host snapshots (rehydration). Processes never stop when switching.
 */
export function WorkspaceArea() {
  const project = useProjectsStore(activeProject);
  const projects = useProjectsStore((s) => s.projects);
  const mounted = useWorkspacesStore((s) => s.mounted);
  const keepAlive = useSettingsStore((s) => s.settings?.['workspace.keepAliveProjects'] ?? 4);
  const activeId = project && !project.missing ? project.id : null;

  useEffect(() => {
    if (activeId) useWorkspacesStore.getState().activate(activeId, keepAlive, hasUnsavedEdits);
  }, [activeId, keepAlive]);

  useEffect(() => {
    useWorkspacesStore.getState().retain(new Set(projects.filter((p) => !p.missing).map((p) => p.id)));
  }, [projects]);

  return (
    <div className="relative h-full">
      {mounted.map((id) => (
        <div
          key={id}
          data-testid="mounted-workspace"
          data-workspace-id={id}
          aria-hidden={id !== activeId}
          className="absolute inset-0"
          style={{ display: id === activeId ? 'block' : 'none' }}
        >
          <ProjectWorkspace projectId={id} active={id === activeId} />
        </div>
      ))}
      {!project && (projects.length > 0 ? <EmptyState title="Select a project" className="h-full" /> : <Welcome />)}
      {project?.missing && <MissingProject project={project} />}
    </div>
  );
}
