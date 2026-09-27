import type { DockviewApi } from 'dockview-react';
import type { FileChange } from '@shared/domain/git';
import { registerCommand } from '../../lib/commands';
import { newPanelId } from '../layout/panel-registry';
import { getActiveWorkspace, getWorkspaceApi } from '../layout/workspace-registry';
import { diffRegistry } from './diff-registry';

export interface DiffPanelParams {
  projectId: string;
  path: string;
  oldPath?: string;
  /** Preview tab: replaced by the next opened diff until it is pinned (double-click). */
  preview: boolean;
}

const fileName = (path: string) => path.split('/').at(-1) ?? path;

const diffPanels = (api: DockviewApi) => api.panels.filter((p) => p.api.component === 'diff');

/**
 * Opens a file's diff in the project's workspace: an existing panel for the
 * path is focused; otherwise the preview panel is reused, or a new panel is added next to the active one.
 */
export function openDiff(
  projectId: string,
  file: Pick<FileChange, 'path' | 'oldPath'>,
  opts: { pinned?: boolean; api?: DockviewApi; focus?: boolean } = {},
): string | null {
  const api = opts.api ?? getWorkspaceApi(projectId);
  if (!api) return null;
  const pinned = opts.pinned ?? false;
  const existing = diffPanels(api).find((p) => (p.params as DiffPanelParams).path === file.path);
  if (existing) {
    if (pinned && (existing.params as DiffPanelParams).preview) {
      existing.api.updateParameters({ ...(existing.params as DiffPanelParams), preview: false });
    }
    existing.api.setActive();
    return existing.id;
  }
  const params: DiffPanelParams = {
    projectId,
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    preview: !pinned,
  };
  const preview = diffPanels(api).find((p) => (p.params as DiffPanelParams).preview);
  if (preview && !pinned) {
    preview.api.updateParameters(params);
    preview.api.setTitle(fileName(file.path));
    preview.api.setActive();
    return preview.id;
  }
  const id = newPanelId('diff');
  api.addPanel<DiffPanelParams>({ id, component: 'diff', params, title: fileName(file.path) });
  return id;
}

/** "Open diff in new group": a pinned diff to the right of the active group. */
export function openDiffInNewGroup(projectId: string, file: Pick<FileChange, 'path' | 'oldPath'>): void {
  const api = getWorkspaceApi(projectId);
  if (!api) return;
  const params: DiffPanelParams = {
    projectId,
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    preview: false,
  };
  api.addPanel<DiffPanelParams>({
    id: newPanelId('diff'),
    component: 'diff',
    params,
    title: fileName(file.path),
    position: api.activeGroup ? { referenceGroup: api.activeGroup, direction: 'right' } : { direction: 'right' },
  });
}

/** Pins a preview diff panel (double-click on its tab or any edit of its view). */
export function pinDiff(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  const params = panel?.params as DiffPanelParams | undefined;
  if (panel && params?.preview) panel.api.updateParameters({ ...params, preview: false });
}

function activeDiff() {
  const id = getActiveWorkspace()?.api.activePanel?.id;
  return id ? diffRegistry.get(id) : undefined;
}

export function registerDiffCommands(): void {
  const hasDiff = () => activeDiff() !== undefined;
  registerCommand({
    id: 'diff.nextChange',
    title: 'Diff: Next Change',
    when: hasDiff,
    run: () => activeDiff()?.goToChange('next'),
  });
  registerCommand({
    id: 'diff.previousChange',
    title: 'Diff: Previous Change',
    when: hasDiff,
    run: () => activeDiff()?.goToChange('previous'),
  });
}
