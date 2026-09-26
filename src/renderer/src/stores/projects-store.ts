import { create } from 'zustand';
import type { Project } from '@shared/domain/project';
import { ipc } from '../lib/ipc-client';

interface ProjectsStore {
  projects: Project[];
  activeId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set) => ({
  projects: [],
  activeId: null,
  loaded: false,
  async load() {
    const [projects, active] = await Promise.all([ipc.invoke('projects:list'), ipc.invoke('projects:getActive')]);
    set({ projects, activeId: active.id, loaded: true });
  },
}));

let subscribed = false;
export function subscribeProjects(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('projects:changed', (projects) => useProjectsStore.setState({ projects }));
  ipc.on('projects:active', ({ id }) => useProjectsStore.setState({ activeId: id }));
}

export const activeProject = (s: { projects: Project[]; activeId: string | null }) =>
  s.projects.find((p) => p.id === s.activeId) ?? null;
