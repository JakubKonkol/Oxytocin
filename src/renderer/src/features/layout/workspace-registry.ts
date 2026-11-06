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

/** Every mounted workspace (drag and drop looks up the one a dragged tab comes from). */
export function getWorkspaceApis(): DockviewApi[] {
  return [...apis.values()];
}

export function setActiveWorkspace(projectId: string | null): void {
  active = projectId;
}

export function getActiveWorkspace(): { projectId: string; api: DockviewApi } | null {
  if (!active) return null;
  const api = apis.get(active);
  return api ? { projectId: active, api } : null;
}

/** How a workspace got its first layout: restored from its saved layout, or a default layout that started terminals. */
export type WorkspaceOpening = 'restored' | 'started-terminals' | 'other';

const openings = new Map<string, Promise<WorkspaceOpening>>();

/** Registered by the workspace while it builds its first layout (restore or default terminals). */
export function trackWorkspaceOpening(projectId: string, opening: Promise<WorkspaceOpening>): void {
  openings.set(projectId, opening);
  const done = () => {
    if (openings.get(projectId) === opening) openings.delete(projectId);
  };
  opening.then(done, done);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/**
 * The project's workspace once it is mounted and has its first layout (null after `timeoutMs`), with how that layout
 * came about (`null` when it was there already).
 */
export async function whenWorkspaceReady(
  projectId: string,
  timeoutMs = 3000,
): Promise<{ api: DockviewApi; opening: WorkspaceOpening | null } | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const api = apis.get(projectId);
    if (api) {
      const opening = openings.get(projectId);
      return { api, opening: opening ? await opening.catch((): WorkspaceOpening => 'other') : null };
    }
    await nextFrame();
  }
  return null;
}
