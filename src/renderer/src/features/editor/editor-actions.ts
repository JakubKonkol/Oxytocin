import type { DockviewApi } from 'dockview-react';
import { registerCommand } from '../../lib/commands';
import { useProjectsStore } from '../../stores/projects-store';
import { notify } from '../../ui/Toast';
import { workspaceFor } from '../attention/reveal';
import { newPanelId } from '../layout/panel-registry';
import { getActiveWorkspace, getWorkspaceApi } from '../layout/workspace-registry';
import { codeRegistry } from './code-registry';

export interface CodePanelParams {
  projectId: string;
  /** Project-relative path. */
  path: string;
  /** Preview tab: replaced by the next opened file until it is pinned (double-click, or an edit). */
  preview: boolean;
}

const fileName = (path: string) => path.split('/').at(-1) ?? path;

const codePanels = (api: DockviewApi) => api.panels.filter((p) => p.api.component === 'code');

/** A line to show once the panel's editor is ready. */
export const pendingReveal = new Map<string, { line: number; column?: number }>();

function reveal(panelId: string, at?: { line?: number | undefined; column?: number | undefined }): void {
  if (!at?.line) return;
  const target = { line: at.line, ...(at.column ? { column: at.column } : {}) };
  const handle = codeRegistry.get(panelId);
  if (handle) handle.revealLine(target.line, target.column);
  else pendingReveal.set(panelId, target);
}

/**
 * Opens a project file in the built-in code editor: an open panel of the file is focused; otherwise the preview
 * panel is reused, or a new panel is added to the active group (to the right with `side`).
 */
export function openFile(
  projectId: string,
  path: string,
  opts: { pinned?: boolean; line?: number; column?: number; api?: DockviewApi; side?: boolean } = {},
): string | null {
  const api = opts.api ?? getWorkspaceApi(projectId);
  if (!api) return null;
  const pinned = opts.pinned ?? false;
  const existing = codePanels(api).find((p) => (p.params as CodePanelParams).path === path);
  if (existing && !opts.side) {
    if (pinned && (existing.params as CodePanelParams).preview)
      existing.api.updateParameters({ ...(existing.params as CodePanelParams), preview: false });
    existing.api.setActive();
    reveal(existing.id, opts);
    return existing.id;
  }
  const params: CodePanelParams = { projectId, path, preview: !pinned && !opts.side };
  const preview = codePanels(api).find((p) => (p.params as CodePanelParams).preview);
  if (preview && !pinned && !opts.side && !codeRegistry.get(preview.id)?.isDirty()) {
    preview.api.updateParameters(params);
    preview.api.setTitle(fileName(path));
    preview.api.setActive();
    reveal(preview.id, opts);
    return preview.id;
  }
  const id = newPanelId('code');
  if (opts.line) pendingReveal.set(id, { line: opts.line, ...(opts.column ? { column: opts.column } : {}) });
  api.addPanel<CodePanelParams>({
    id,
    component: 'code',
    params,
    title: fileName(path),
    ...(opts.side
      ? { position: api.activeGroup ? { referenceGroup: api.activeGroup, direction: 'right' } : { direction: 'right' } }
      : {}),
  });
  return id;
}

/** Opens a file of a project in its workspace (activating the project when needed). */
export async function showFile(projectId: string, path: string, at: { line?: number; column?: number } = {}) {
  const api = await workspaceFor(projectId);
  if (!api) return;
  openFile(projectId, path, { pinned: true, api, ...at });
}

/** Pins a preview code panel. */
export function pinCodePanel(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  const params = panel?.params as CodePanelParams | undefined;
  if (panel && params?.preview) panel.api.updateParameters({ ...params, preview: false });
}

function activeCode() {
  const id = getActiveWorkspace()?.api.activePanel?.id;
  return id ? codeRegistry.get(id) : undefined;
}

export function registerEditorCommands(): void {
  const hasProject = () => useProjectsStore.getState().activeId !== null;
  registerCommand({
    id: 'editor.save',
    title: 'Editor: Save',
    when: () => activeCode() !== undefined,
    run: () => void activeCode()?.save(),
  });
  registerCommand({
    id: 'editor.newFile',
    title: 'Files: New File…',
    when: hasProject,
    run: async () => {
      const { newEntry } = await import('./file-ops');
      const id = useProjectsStore.getState().activeId;
      if (id) await newEntry(id, '', 'file');
    },
  });
  registerCommand({
    id: 'files.reveal',
    title: 'Files: Show the FILES Section',
    when: hasProject,
    run: () => {
      const handle = activeCode();
      if (!handle) notify('info', 'Open a file first');
      else handle.revealInFiles();
    },
  });
}
