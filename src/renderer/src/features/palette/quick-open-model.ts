import type { FileChange } from '@shared/domain/git';
import type { Project } from '@shared/domain/project';
import type { TerminalInfo } from '@shared/domain/terminal';
import { fuzzyMatch } from './fuzzy';

/** Quick Open prefixes: none = everything, `>` commands, `@` terminals, `#` changed files. */
export type PaletteMode = 'all' | 'commands' | 'terminals' | 'files';

const PREFIXES: Record<string, PaletteMode> = { '>': 'commands', '@': 'terminals', '#': 'files' };
export const MODE_PREFIX: Record<PaletteMode, string> = { all: '', commands: '>', terminals: '@', files: '#' };

export function parseQuery(input: string): { mode: PaletteMode; text: string } {
  const mode = PREFIXES[input.charAt(0)];
  return mode ? { mode, text: input.slice(1).trim() } : { mode: 'all', text: input.trim() };
}

export type PaletteAction =
  | { kind: 'command'; id: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; projectId: string; terminalId: string }
  | { kind: 'file'; projectId: string; path: string; oldPath?: string }
  | { kind: 'pick'; index: number };

export interface PaletteItem {
  /** Unique cmdk value. */
  id: string;
  group: string;
  label: string;
  /** Muted text after the label (category, folder, project name). */
  detail?: string;
  /** Text the query is matched against; the label starts at `labelOffset` inside it. */
  matchText: string;
  labelOffset: number;
  /** Second line under the label (plugin picks). */
  subline?: string;
  /** Keybinding chord (commands). */
  shortcut?: string;
  icon:
    | { kind: 'command' }
    | { kind: 'project'; project: Pick<Project, 'name' | 'color' | 'icon'> }
    | { kind: 'terminal'; agent: boolean }
    | { kind: 'file'; status: FileChange['status'] }
    | { kind: 'none' };
  action: PaletteAction;
}

export interface RankedItem extends PaletteItem {
  indices: number[];
}

export interface QuickOpenSources {
  commands: readonly { id: string; title: string }[];
  recentCommands: readonly string[];
  projects: readonly Project[];
  activeProjectId: string | null;
  terminals: readonly TerminalInfo[];
  changes: readonly FileChange[];
  shortcutFor: (commandId: string) => string | undefined;
}

export const GROUPS = {
  recent: 'Recently used',
  commands: 'Commands',
  otherCommands: 'Other commands',
  projects: 'Projects',
  terminals: 'Terminals',
  files: 'Changed files',
} as const;

/** "Terminal: Split Right" → category "Terminal", label "Split Right". */
export function splitTitle(title: string): { category?: string; label: string } {
  const at = title.indexOf(': ');
  return at > 0 ? { category: title.slice(0, at), label: title.slice(at + 2) } : { label: title };
}

function commandItems(s: QuickOpenSources): PaletteItem[] {
  const recentRank = new Map(s.recentCommands.map((id, i) => [id, i]));
  const sorted = [...s.commands].sort((a, b) => {
    const ra = recentRank.get(a.id) ?? Infinity;
    const rb = recentRank.get(b.id) ?? Infinity;
    return ra !== rb ? ra - rb : a.title.localeCompare(b.title);
  });
  return sorted.map((c) => {
    const shortcut = s.shortcutFor(c.id);
    const recent = recentRank.has(c.id);
    return {
      id: `command:${c.id}`,
      group: recent ? GROUPS.recent : s.recentCommands.length ? GROUPS.otherCommands : GROUPS.commands,
      label: c.title,
      matchText: c.title,
      labelOffset: 0,
      ...(shortcut ? { shortcut } : {}),
      icon: { kind: 'command' },
      action: { kind: 'command', id: c.id },
    };
  });
}

function projectItems(s: QuickOpenSources): PaletteItem[] {
  return s.projects.map((p) => ({
    id: `project:${p.id}`,
    group: GROUPS.projects,
    label: p.name,
    detail: p.id === s.activeProjectId ? `${p.rootPath} · active` : p.rootPath,
    matchText: p.name,
    labelOffset: 0,
    icon: { kind: 'project', project: p },
    action: { kind: 'project', projectId: p.id },
  }));
}

function terminalItems(s: QuickOpenSources): PaletteItem[] {
  const names = new Map(s.projects.map((p) => [p.id, p.name]));
  // Active project first, then the others; newest terminals first within a project.
  const list = s.terminals
    .filter((t) => names.has(t.projectId))
    .sort((a, b) => {
      const pa = a.projectId === s.activeProjectId ? 0 : 1;
      const pb = b.projectId === s.activeProjectId ? 0 : 1;
      return pa !== pb ? pa - pb : b.createdAt - a.createdAt;
    });
  return list.map((t) => {
    const project = names.get(t.projectId)!;
    const agent = t.agent ? `${t.agent.displayName} · ` : '';
    return {
      id: `terminal:${t.id}`,
      group: GROUPS.terminals,
      label: t.title,
      detail: `${agent}${project}${t.state === 'exited' ? ' · exited' : ''}`,
      matchText: `${t.title} ${project}`,
      labelOffset: 0,
      icon: { kind: 'terminal', agent: t.kind === 'agent' || !!t.agent },
      action: { kind: 'terminal', projectId: t.projectId, terminalId: t.id },
    };
  });
}

function fileItems(s: QuickOpenSources): PaletteItem[] {
  const projectId = s.activeProjectId;
  if (!projectId) return [];
  return s.changes.map((f) => {
    const slash = f.path.lastIndexOf('/');
    const name = f.path.slice(slash + 1);
    return {
      id: `file:${f.path}`,
      group: GROUPS.files,
      label: name,
      ...(slash > 0 ? { detail: f.path.slice(0, slash) } : {}),
      matchText: f.path,
      labelOffset: slash + 1,
      icon: { kind: 'file', status: f.status },
      action: { kind: 'file', projectId, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) },
    };
  });
}

export function buildItems(mode: PaletteMode, s: QuickOpenSources): PaletteItem[] {
  switch (mode) {
    case 'commands':
      return commandItems(s);
    case 'terminals':
      return terminalItems(s);
    case 'files':
      return fileItems(s);
    case 'all':
      return [...projectItems(s), ...terminalItems(s), ...fileItems(s)];
  }
}

/** Items of a plugin's quick pick (`oxy.ui.showQuickPick`). */
export function pickItems(items: readonly { label: string; description?: string; detail?: string }[]): PaletteItem[] {
  return items.map((item, index) => ({
    id: `pick:${index}`,
    group: '',
    label: item.label,
    ...(item.description ? { detail: item.description } : {}),
    ...(item.detail ? { subline: item.detail } : {}),
    matchText: item.description ? `${item.label} ${item.description}` : item.label,
    labelOffset: 0,
    icon: { kind: 'none' },
    action: { kind: 'pick', index },
  }));
}

const GROUP_LIMIT = 50;

/**
 * Filters and orders items for a query. Without a query the natural order is kept (recently used commands
 * first). With a query each group is sorted by score (commands merge into one group, recent ones get a small
 * boost) and capped at `limit` entries per group.
 */
export function rankItems(items: readonly PaletteItem[], text: string, limit = GROUP_LIMIT): RankedItem[] {
  if (!text) {
    const counts = new Map<string, number>();
    return items
      .filter((item) => {
        const n = (counts.get(item.group) ?? 0) + 1;
        counts.set(item.group, n);
        return n <= limit;
      })
      .map((item) => ({ ...item, indices: [] }));
  }
  const scored: { item: RankedItem; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const m = fuzzyMatch(item.matchText, text);
    if (!m) return;
    const recent = item.group === GROUPS.recent;
    const group = recent || item.group === GROUPS.otherCommands ? GROUPS.commands : item.group;
    scored.push({ item: { ...item, group, indices: m.indices }, score: m.score + (recent ? 1 : 0), order });
  });
  const groupOrder = [...new Set(scored.map((s) => s.item.group))];
  const out: RankedItem[] = [];
  for (const group of groupOrder) {
    const inGroup = scored.filter((s) => s.item.group === group);
    inGroup.sort((a, b) => b.score - a.score || a.order - b.order);
    out.push(...inGroup.slice(0, limit).map((s) => s.item));
  }
  return out;
}
