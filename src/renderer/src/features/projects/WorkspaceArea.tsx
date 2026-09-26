import { FolderX } from 'lucide-react';
import logoStacked from '../../assets/brand/logo-stacked-on-dark.svg';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { activeProject, useProjectsStore } from '../../stores/projects-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { ProjectWorkspace } from '../layout/ProjectWorkspace';
import { addProjectViaDialog, locateProjectFolder, removeProject } from './project-actions';
import { addDroppedFolders } from './ProjectsSection';

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

/** Center area: the active project's workspace, the welcome screen or a "folder not found" card. */
export function WorkspaceArea() {
  const project = useProjectsStore(activeProject);
  const hasProjects = useProjectsStore((s) => s.projects.length > 0);
  if (!project) {
    return hasProjects ? <EmptyState title="Select a project" className="h-full" /> : <Welcome />;
  }
  if (project.missing) {
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
  return <ProjectWorkspace key={project.id} projectId={project.id} active />;
}
