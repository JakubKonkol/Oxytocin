import { create } from 'zustand';
import type { ProjectRuntimeStatus } from '@shared/domain/activity';
import type { Project } from '@shared/domain/project';
import type { CodeMapStatus } from '@shared/domain/code-map';
import { ipc } from '../lib/ipc-client';

interface ProjectsStore {
  projects: Project[];
  activeId: string | null;
  loaded: boolean;
  /** Runtime status per project from main (activity dot, counters). */
  activity: Record<string, ProjectRuntimeStatus>;
  codeMaps: Record<string, CodeMapStatus>;
  load: () => Promise<void>;
}

export const useProjectsStore = create<ProjectsStore>((set) => ({
  projects: [],
  activeId: null,
  loaded: false,
  activity: {},
  codeMaps: {},
  async load() {
    const [projects, active, activity] = await Promise.all([
      ipc.invoke('projects:list'),
      ipc.invoke('projects:getActive'),
      ipc.invoke('projects:getActivity'),
    ]);
    set({
      projects,
      activeId: active.id,
      loaded: true,
      activity: Object.fromEntries(activity.map((a) => [a.projectId, a])),
    });
    await Promise.all(
      projects
        .filter((p) => p.settings.codeMap?.enabled)
        .map(async (p) => {
          const status = await ipc.invoke('codeMap:getStatus', { projectId: p.id });
          set((s) => ({ codeMaps: { ...s.codeMaps, [p.id]: status } }));
        }),
    );
  },
}));

let subscribed = false;
export function subscribeProjects(): void {
  if (subscribed) return;
  subscribed = true;
  ipc.on('codeMap:status', (status) =>
    useProjectsStore.setState((s) => ({ codeMaps: { ...s.codeMaps, [status.checkoutId]: status } })),
  );
  ipc.on('projects:changed', (projects) => useProjectsStore.setState({ projects }));
  ipc.on('projects:active', ({ id }) => useProjectsStore.setState({ activeId: id }));
  ipc.on('projects:activity', (changed) =>
    useProjectsStore.setState((s) => ({
      activity: { ...s.activity, ...Object.fromEntries(changed.map((a) => [a.projectId, a])) },
    })),
  );
}

export const activeProject = (s: { projects: Project[]; activeId: string | null }) =>
  s.projects.find((p) => p.id === s.activeId) ?? null;
