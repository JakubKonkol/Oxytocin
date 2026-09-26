import type { Project } from '@shared/domain/project';
import { ipc } from '../../lib/ipc-client';
import { notify } from '../../ui/Toast';

/** Absolute path of a project-relative ('/' separated) path with the project's separator. */
export function absolutePath(project: Pick<Project, 'rootPath'>, relative: string): string {
  const sep = project.rootPath.includes('\\') ? '\\' : '/';
  return `${project.rootPath.replace(/[\\/]+$/, '')}${sep}${relative.split('/').join(sep)}`;
}

export async function openInEditor(project: Project, relative: string): Promise<void> {
  try {
    await ipc.invoke('editor:open', { path: absolutePath(project, relative) });
  } catch (e) {
    notify('error', 'Could not open the file', { description: e instanceof Error ? e.message : String(e) });
  }
}

export function revealInFolder(project: Project, relative: string): void {
  void ipc.invoke('shell:revealInFolder', { path: absolutePath(project, relative) });
}

export async function copyText(text: string): Promise<void> {
  await ipc.invoke('clipboard:writeText', { text });
}

export function refreshChanges(projectId: string): void {
  void ipc.invoke('git:refresh', { projectId });
}
