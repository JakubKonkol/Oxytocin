import { useMemo } from 'react';
import { usePluginsStore } from '../../stores/plugins-store';
import { useUiStore } from '../../stores/ui-store';
import { getSidebarPaneviewApi, requestSidebarReveal } from './tools';

/**
 * Sections of the left sidebar: the core sections (Projects, Changes, Files) and the plugins' sidebar views (Usage).
 * They belong to the left sidebar — lists that navigate the project — so they are closed and added again only there.
 * Tools (the scratchpad, plugin panels) go anywhere: both sidebars and the workspace.
 */
export interface SidebarSectionDefinition {
  id: string;
  title: string;
  /** Position among the sections when no saved order says otherwise. */
  order: number;
}

export interface CoreSectionDefinition extends SidebarSectionDefinition {
  size: number;
  /** Starts collapsed until the user expands it. */
  collapsedByDefault?: boolean;
}

export const CORE_SECTIONS: CoreSectionDefinition[] = [
  { id: 'projects', title: 'Projects', size: 200, order: 0 },
  { id: 'changes', title: 'Changes', size: 380, order: 100 },
  { id: 'files', title: 'Files', size: 320, order: 150, collapsedByDefault: true },
];

export const pluginSectionId = (pluginId: string, viewId: string) => `plugin:${pluginId}:${viewId}`;

type ViewContribution = ReturnType<typeof usePluginsStore.getState>['contributions']['views'][number];

/** Every section the left sidebar can show, in their default order. */
export function sidebarSections(views: readonly ViewContribution[]): SidebarSectionDefinition[] {
  return [
    ...CORE_SECTIONS.map(({ id, title, order }) => ({ id, title, order })),
    ...views.map((v) => ({ id: pluginSectionId(v.pluginId, v.id), title: v.title, order: v.order })),
  ].sort((a, b) => a.order - b.order);
}

export function useSidebarSections(): SidebarSectionDefinition[] {
  const views = usePluginsStore((s) => s.contributions.views);
  return useMemo(() => sidebarSections(views), [views]);
}

/** Where a section added back without an explicit position goes: after the sections that precede it by default. */
export function defaultSectionIndex(
  id: string,
  panelIds: readonly string[],
  sections: readonly SidebarSectionDefinition[],
): number {
  const rank = new Map(sections.map((s) => [s.id, s.order]));
  const own = rank.get(id) ?? 1000;
  let index = 0;
  panelIds.forEach((p, i) => {
    const r = rank.get(p);
    if (r !== undefined && r <= own) index = i + 1;
  });
  return index;
}

/** Paneview index a section added from a "+" menu asked for (read once). */
const pendingIndex = new Map<string, number>();

export function takePendingSectionIndex(id: string): number | undefined {
  const index = pendingIndex.get(id);
  pendingIndex.delete(id);
  return index;
}

/** Closes a section of the left sidebar (the "×" of its header). */
export function closeSidebarSection(id: string): void {
  useUiStore.getState().setSectionHidden(id, true);
}

/**
 * Shows a section of the left sidebar: the sidebar opens, a closed section comes back (at paneview `index`, else
 * at its default position) and it is expanded.
 */
export function revealSidebarSection(id: string, index?: number): void {
  const ui = useUiStore.getState();
  if (ui.state.sidebar.collapsed) ui.toggleSidebar();
  if (ui.state.paneview.hidden.includes(id)) {
    if (index !== undefined) pendingIndex.set(id, index);
    ui.setSectionHidden(id, false);
  }
  requestSidebarReveal(id);
}

/** Index just below a section or tool of the left sidebar (where its "+" adds things). */
export function indexBelow(id: string): number | undefined {
  const panels = getSidebarPaneviewApi('left')?.panels;
  const i = panels?.findIndex((p) => p.id === id) ?? -1;
  return i < 0 ? undefined : i + 1;
}

/** Waits (a few frames at most) for an element of a section that is being revealed, then focuses it. */
export function focusWhenReady(selector: string, frames = 30): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) {
    el.focus();
    return;
  }
  if (frames > 0) requestAnimationFrame(() => focusWhenReady(selector, frames - 1));
}
