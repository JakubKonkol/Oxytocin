import type { DockviewApi } from 'dockview-react';

/** projectId → live dockview API of its mounted workspace. */
const apis = new Map<string, DockviewApi>();
let active: string | null = null;

export function setWorkspaceApi(projectId: string, api: DockviewApi | null): void {
  if (api) apis.set(projectId, api);
  else apis.delete(projectId);
}

export function getWorkspaceApi(projectId: string): DockviewApi | undefined {
  return apis.get(projectId);
}

export function setActiveWorkspace(projectId: string | null): void {
  active = projectId;
}

export function getActiveWorkspace(): { projectId: string; api: DockviewApi } | null {
  if (!active) return null;
  const api = apis.get(active);
  return api ? { projectId: active, api } : null;
}
