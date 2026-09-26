import { FolderPlus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { SectionBody } from '../../ui/Section';
import { addProjectPath, addProjectViaDialog, reorderProjects } from './project-actions';
import { PROJECT_DRAG_TYPE, ProjectItem } from './ProjectItem';

const FILTER_THRESHOLD = 8;

/** Accepts folders dropped from the OS file manager (paths via webUtils.getPathForFile in the preload). */
export async function addDroppedFolders(files: readonly File[]): Promise<void> {
  const paths = files.map((f) => window.oxy.getPathForFile(f)).filter(Boolean);
  for (const path of paths) await addProjectPath(path);
}

/** Body of the PROJECTS sidebar section. */
export function ProjectsSection() {
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const terminals = useTerminalsStore((s) => s.terminals);
  const [filter, setFilter] = useState('');
  const [fileOver, setFileOver] = useState(false);
  const dragged = useRef<string | null>(null);

  const byProject = useMemo(() => {
    const map = new Map<string, (typeof terminals)[string][]>();
    for (const t of Object.values(terminals)) {
      const list = map.get(t.projectId) ?? [];
      list.push(t);
      map.set(t.projectId, list);
    }
    return map;
  }, [terminals]);

  const visible = filter
    ? projects.filter((p) => `${p.name} ${p.rootPath}`.toLowerCase().includes(filter.toLowerCase()))
    : projects;

  const dropOn = (targetId: string, after: boolean) => {
    const source = dragged.current;
    dragged.current = null;
    if (!source || source === targetId) return;
    const target = projects.find((p) => p.id === targetId);
    const moving = projects.find((p) => p.id === source);
    if (!target || !moving || target.pinned !== moving.pinned) return; // reorder within the pinned/unpinned group
    const ids = projects.map((p) => p.id).filter((id) => id !== source);
    const index = ids.indexOf(targetId) + (after ? 1 : 0);
    ids.splice(index, 0, source);
    reorderProjects(ids);
  };

  return (
    <SectionBody className="flex flex-col px-1 pt-1">
      <div
        data-testid="projects-dropzone"
        data-keycontext="sidebar"
        className={cn(
          'flex min-h-full flex-1 flex-col rounded-control',
          fileOver && 'bg-accent-muted/30 ring-1 ring-accent',
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setFileOver(true);
        }}
        onDragLeave={() => setFileOver(false)}
        onDrop={(e) => {
          setFileOver(false);
          if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
          e.preventDefault();
          void addDroppedFolders([...e.dataTransfer.files]);
        }}
      >
        {projects.length > FILTER_THRESHOLD && (
          <input
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mx-1 mb-1 h-6 rounded-badge border border-line bg-input px-2 text-small text-fg outline-none focus:border-line-focus"
          />
        )}
        {projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Drop a folder here or add one."
            actions={
              <Button size="sm" variant="secondary" onClick={() => void addProjectViaDialog()}>
                <FolderPlus size={12} /> Add project
              </Button>
            }
            className="py-3"
          />
        ) : (
          <div role="listbox" aria-label="Projects" data-testid="projects-list" className="flex flex-col gap-px">
            {visible.map((p) => (
              <ProjectItem
                key={p.id}
                project={p}
                active={p.id === activeId}
                terminals={byProject.get(p.id) ?? []}
                onDragStart={(id) => (dragged.current = id)}
                onDropOn={dropOn}
              />
            ))}
          </div>
        )}
      </div>
    </SectionBody>
  );
}
