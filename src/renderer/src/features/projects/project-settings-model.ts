import type { Project, ProjectPatch, StartupTerminal } from '@shared/domain/project';

export interface EnvRow {
  key: string;
  value: string;
  /** Removes the variable from inherited environments (`null` in the settings). */
  unset: boolean;
}

export interface StartupRow {
  name: string;
  profileId: string;
  command: string;
  cwd: string;
  placement: 'tab' | 'right' | 'below';
}

/** Editable copy of a project's settings. */
export interface ProjectDraft {
  name: string;
  color: number;
  /** Empty = the first letter of the name. */
  icon: string;
  defaultProfileId: string;
  env: EnvRow[];
  startup: StartupRow[];
  editorCommand: string;
  gitEnabled: boolean;
  /** One folder per line. */
  ignoredFolders: string;
}

export function draftOf(project: Project): ProjectDraft {
  const s = project.settings;
  return {
    name: project.name,
    color: project.color,
    icon: project.icon?.value ?? '',
    defaultProfileId: s.defaultProfileId ?? '',
    env: Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value: value ?? '', unset: value === null })),
    startup: (s.startupTerminals ?? []).map((t) => ({
      name: t.name ?? '',
      profileId: t.profileId ?? '',
      command: t.command ?? '',
      cwd: t.cwd ?? '',
      placement: t.placement ?? 'tab',
    })),
    editorCommand: s.editorCommand ?? '',
    gitEnabled: s.git?.enabled !== false,
    ignoredFolders: (s.git?.ignoredFolders ?? []).join('\n'),
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Problems that block saving (shown next to the fields). */
export function validateDraft(d: ProjectDraft): string[] {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push('The name cannot be empty.');
  if ([...d.icon.trim()].length > 2) problems.push('The icon is one letter or one emoji.');
  const seen = new Set<string>();
  for (const row of d.env) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!ENV_NAME.test(key)) problems.push(`"${key || '(empty)'}" is not a valid variable name.`);
    else if (seen.has(key)) problems.push(`${key} is defined twice.`);
    seen.add(key);
  }
  d.startup.forEach((t, i) => {
    if (t.cwd.trim() && (/^([a-zA-Z]:)?[\\/]/.test(t.cwd.trim()) || t.cwd.split(/[\\/]/).includes('..')))
      problems.push(`Startup terminal ${i + 1}: the folder must be inside the project (a relative path).`);
  });
  return problems;
}

const trimmed = (v: string) => v.trim() || undefined;

/** The patch that turns the project into the draft. Empty fields are left out of the stored settings. */
export function patchFromDraft(project: Project, d: ProjectDraft): ProjectPatch {
  const env: Record<string, string | null> = {};
  for (const row of d.env) {
    const key = row.key.trim();
    if (key) env[key] = row.unset ? null : row.value;
  }
  const startupTerminals: StartupTerminal[] = d.startup.map((t) => ({
    ...(trimmed(t.name) ? { name: t.name.trim() } : {}),
    ...(trimmed(t.profileId) ? { profileId: t.profileId } : {}),
    ...(trimmed(t.command) ? { command: t.command.trim() } : {}),
    ...(trimmed(t.cwd) ? { cwd: t.cwd.trim() } : {}),
    ...(t.placement !== 'tab' ? { placement: t.placement } : {}),
  }));
  const ignoredFolders = d.ignoredFolders
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const icon = d.icon.trim();
  return {
    id: project.id,
    name: d.name.trim(),
    color: d.color,
    icon: icon ? { kind: /^[A-Za-z0-9]$/.test(icon) ? 'letter' : 'emoji', value: icon } : null,
    settings: {
      ...(d.defaultProfileId ? { defaultProfileId: d.defaultProfileId } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(startupTerminals.length ? { startupTerminals } : {}),
      ...(trimmed(d.editorCommand) ? { editorCommand: d.editorCommand.trim() } : {}),
      ...(!d.gitEnabled || ignoredFolders.length
        ? {
            git: { ...(!d.gitEnabled ? { enabled: false } : {}), ...(ignoredFolders.length ? { ignoredFolders } : {}) },
          }
        : {}),
    },
  };
}

/** Moves an item (drag and drop in the startup list). */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}
