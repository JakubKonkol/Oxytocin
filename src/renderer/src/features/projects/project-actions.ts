import type { Project } from '@shared/domain/project';
import { OxyError } from '@shared/errors';
import { executeCommand, registerCommand } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { confirmDialogEx } from '../../stores/dialog-store';
import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function addProjectPath(path: string): Promise<void> {
  try {
    const result = await ipc.invoke('projects:add', { path });
    if (result.warning) notify('info', result.warning);
    else if (result.existed) notify('info', `‘${result.project.name}’ is already in the list`);
  } catch (e) {
    if (e instanceof OxyError && e.code === 'INVALID')
      notify('error', 'Could not add the project', { description: e.message });
    else notify('error', 'Could not add the project', { description: errorText(e) });
  }
}

export async function addProjectViaDialog(): Promise<void> {
  const path = await ipc.invoke('projects:pickFolder');
  if (path) await addProjectPath(path);
}

export function activateProject(id: string): void {
  if (useProjectsStore.getState().activeId === id) return;
  useProjectsStore.setState({ activeId: id });
  void ipc.invoke('projects:setActive', { id });
}

export async function removeProject(project: Project): Promise<void> {
  const terminals = Object.values(useTerminalsStore.getState().terminals).filter((t) => t.projectId === project.id);
  const running = terminals.filter((t) => t.state === 'running');
  const result = await confirmDialogEx({
    title: `Remove ‘${project.name}’ from Oxytocin?`,
    description: 'The folder on disk is not touched.',
    confirmLabel: 'Remove',
    destructive: true,
    ...(terminals.length > 0
      ? {
          checkbox: {
            label: `Also close its ${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`,
            defaultChecked: running.length > 0,
          },
        }
      : {}),
  });
  if (!result.confirmed) return;
  await ipc.invoke('projects:remove', { id: project.id, killTerminals: result.checked || terminals.length === 0 });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await ipc.invoke('projects:update', { id, name: trimmed });
  } catch (e) {
    notify('error', 'Could not rename the project', { description: errorText(e) });
  }
}

export async function locateProjectFolder(project: Project): Promise<void> {
  const path = await ipc.invoke('projects:pickFolder');
  if (!path) return;
  try {
    await ipc.invoke('projects:update', { id: project.id, rootPath: path });
  } catch (e) {
    notify('error', 'Could not use this folder', { description: errorText(e) });
  }
}

export function reorderProjects(orderedIds: string[]): void {
  const byId = new Map(useProjectsStore.getState().projects.map((p) => [p.id, p]));
  useProjectsStore.setState({ projects: orderedIds.map((id) => byId.get(id)!).filter(Boolean) });
  void ipc.invoke('projects:reorder', { ids: orderedIds });
}

function cycle(step: 1 | -1): void {
  const { projects, activeId } = useProjectsStore.getState();
  if (projects.length === 0) return;
  const index = projects.findIndex((p) => p.id === activeId);
  const next = projects[(index + step + projects.length) % projects.length];
  if (next) activateProject(next.id);
}

export function registerProjectCommands(): void {
  registerCommand({ id: 'projects.add', title: 'Projects: Add Project…', run: () => addProjectViaDialog() });
  registerCommand({
    id: 'projects.activateIndex',
    title: 'Projects: Open Project by Position',
    internal: true,
    run: (index) => {
      const p = useProjectsStore.getState().projects[Number(index)];
      if (p) activateProject(p.id);
    },
  });
  registerCommand({ id: 'projects.next', title: 'Projects: Next Project', run: () => cycle(1) });
  registerCommand({ id: 'projects.previous', title: 'Projects: Previous Project', run: () => cycle(-1) });
  registerCommand({
    id: 'workbench.focusProjects',
    title: 'View: Focus Projects',
    run: () =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="projects-list"] [aria-selected="true"], [data-testid="projects-list"] [role="option"]',
        )
        ?.focus(),
  });
  registerCommand({
    id: 'projects.newTerminal',
    title: 'Projects: New Terminal in Project',
    internal: true,
    run: async (id) => {
      activateProject(String(id));
      await new Promise((r) => setTimeout(r, 50));
      await executeCommand('terminal.new');
    },
  });
}
