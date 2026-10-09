import type { DockviewApi } from 'dockview-react';
import { create } from 'zustand';
import type { FileChange } from '@shared/domain/git';
import { registerCommand } from '../../lib/commands';
import { useProjectsStore } from '../../stores/projects-store';
import { notify } from '../../ui/Toast';
import { workspaceFor } from '../attention/reveal';
import { getActiveWorkspace } from '../layout/workspace-registry';

export const REVIEW_PANEL_TITLE = 'Review';
const panelId = (projectId: string) => `review-${projectId.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 80);

/** A file the review panel should scroll to (set before the panel mounts, read by it). */
export const useReviewFocus = create<{ focus: Record<string, { path: string; nonce: number } | undefined> }>(() => ({
  focus: {},
}));

let nonce = 0;

/** Opens (or activates) the review of a project's changes; `path` scrolls to that file. */
export function openReviewPanel(api: DockviewApi, projectId: string, path?: string): void {
  if (path) useReviewFocus.setState((s) => ({ focus: { ...s.focus, [projectId]: { path, nonce: ++nonce } } }));
  const existing = api.panels.find((p) => p.api.component === 'review');
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id: panelId(projectId), component: 'review', title: REVIEW_PANEL_TITLE, params: { projectId } });
}

export async function openReview(projectId: string, path?: string): Promise<void> {
  const api = await workspaceFor(projectId);
  if (api) openReviewPanel(api, projectId, path);
}

/** Fingerprint of a change: marking a file as viewed holds until the file changes again. */
export const changeFingerprint = (f: Pick<FileChange, 'status' | 'additions' | 'deletions'>) =>
  `${f.status}:${f.additions ?? '-'}:${f.deletions ?? '-'}`;

export function registerReviewCommands(): void {
  registerCommand({
    id: 'git.review',
    title: 'Git: Review All Changes',
    when: () => useProjectsStore.getState().activeId !== null,
    run: () => {
      const id = useProjectsStore.getState().activeId;
      const api = getActiveWorkspace()?.api;
      if (!id) notify('info', 'Open a project first');
      else if (api) openReviewPanel(api, id);
      else void openReview(id);
    },
  });
}
