import type { RunProfile, ScriptLanguage, ScriptSpec } from '../shared/types';
import type { DetectedProfile } from './detect';
import { SCRIPT_LANGUAGES } from './scripts';

export type { RunProfile, ScriptSpec };

/** User edits of a detected profile (only the fields that differ). */
export interface ProfileOverride {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
}

/** What is stored per project (`ctx.storage`, key `project:<id>`). */
export interface ProjectRunConfig {
  custom: RunProfile[];
  /** Detected profiles the user removed. */
  hidden: string[];
  overrides: Record<string, ProfileOverride>;
}

export const emptyConfig = (): ProjectRunConfig => ({ custom: [], hidden: [], overrides: {} });

/** Reads a stored config defensively (older or hand-edited data). */
export function normalizeConfig(value: unknown): ProjectRunConfig {
  const v = (value ?? {}) as Partial<ProjectRunConfig>;
  const custom = Array.isArray(v.custom)
    ? v.custom.filter(
        (p): p is RunProfile =>
          !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.command === 'string',
      )
    : [];
  return {
    custom: custom.map((p) => {
      const script = normalizeScript(p.script);
      const profile: RunProfile = {
        ...p,
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        source: 'custom',
        kind: script ? 'script' : 'custom',
      };
      if (script) profile.script = script;
      else delete profile.script;
      return profile;
    }),
    hidden: Array.isArray(v.hidden) ? v.hidden.filter((h): h is string => typeof h === 'string') : [],
    overrides: v.overrides && typeof v.overrides === 'object' ? v.overrides : {},
  };
}

function normalizeScript(value: unknown): ScriptSpec | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ScriptSpec;
  if (typeof v.file === 'string' && v.file) return { file: v.file };
  if (typeof v.inline === 'string')
    return { inline: v.inline, ...(SCRIPT_LANGUAGES.includes(v.language!) ? { language: v.language! } : {}) };
  return undefined;
}

/** The profiles AI agents see (the user can keep a profile from them). */
export const agentProfiles = (profiles: RunProfile[]) => profiles.filter((p) => !p.hiddenFromAgents);

/** Detected profiles (minus hidden ones, with the user's edits) followed by the user's own profiles. */
export function mergeProfiles(detected: DetectedProfile[], config: ProjectRunConfig): RunProfile[] {
  const hidden = new Set(config.hidden);
  const out: RunProfile[] = [];
  for (const d of detected) {
    if (hidden.has(d.id)) continue;
    const o = config.overrides[d.id];
    out.push({
      ...d,
      source: 'detected',
      ...(o ? { ...o, edited: true } : {}),
    });
  }
  return [...out, ...config.custom];
}

export interface ProfileInput {
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  url?: unknown;
  /** A custom script instead of a command: `{ file }` or `{ inline, language }`. */
  script?: unknown;
  hiddenFromAgents?: unknown;
  newTerminal?: unknown;
}

export interface ValidProfileInput {
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  url?: string;
}

/** `KEY=value` lines → an object (blank lines and `#` comments are skipped). */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return env;
}

/** A folder relative to the project root (`/` separators, `''` = the root); throws for anything else. */
function validateFolder(input: unknown): string {
  let cwd = typeof input === 'string' ? input.trim().replace(/\\/g, '/') : '';
  cwd = cwd.replace(/^(\.\/+)+/, '').replace(/\/+$/, '');
  if (cwd === '.') cwd = '';
  if (/^([a-zA-Z]:)?\//.test(cwd) || cwd.split('/').includes('..'))
    throw new Error('The folder must be relative to the project root (e.g. "apps/web").');
  return cwd;
}

function validateName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name) throw new Error('A profile needs a name.');
  if (name.length > 80) throw new Error('The name is longer than 80 characters.');
  return name;
}

/** Validates a profile from the UI or an agent; throws a readable error. */
export function validateProfileInput(input: ProfileInput): ValidProfileInput {
  const name = validateName(input.name);
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) throw new Error('A profile needs a command.');
  if (command.length > 2000) throw new Error('The command is longer than 2000 characters.');
  const cwd = validateFolder(input.cwd);
  let env: Record<string, string> | undefined;
  if (typeof input.env === 'string') env = parseEnvLines(input.env);
  else if (input.env && typeof input.env === 'object')
    env = Object.fromEntries(
      Object.entries(input.env as Record<string, unknown>)
        .filter(([k]) => k.trim() !== '')
        .map(([k, v]) => [k.trim(), String(v)]),
    );
  for (const key of Object.keys(env ?? {}))
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('The URL must start with http:// or https://.');
  return {
    name,
    command,
    cwd,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(url ? { url } : {}),
  };
}

export const MAX_INLINE_SCRIPT = 20_000;

/** A custom script from the UI, before its file is checked and its command is built (see index.ts). */
export interface ValidScriptInput {
  name: string;
  /** `undefined` when no folder was given: the script file's folder is used. */
  cwd: string | undefined;
  env?: Record<string, string>;
  url?: string;
  /** `file` as typed (normalized against the project root later) or the written script. */
  script: { file: string } | { inline: string; language: ScriptLanguage };
  hiddenFromAgents: boolean;
  newTerminal: boolean;
}

/** Validates a custom script from the UI; throws a readable error. */
export function validateScriptInput(input: ProfileInput, fallbackLanguage: ScriptLanguage): ValidScriptInput {
  const name = validateName(input.name);
  const raw = (input.script ?? {}) as { file?: unknown; inline?: unknown; language?: unknown };
  let script: ValidScriptInput['script'];
  if (typeof raw.inline === 'string') {
    if (!raw.inline.trim()) throw new Error('Write the script or choose a script file.');
    if (raw.inline.length > MAX_INLINE_SCRIPT)
      throw new Error(`The script is longer than ${MAX_INLINE_SCRIPT} characters; save it as a file of the project.`);
    const language = SCRIPT_LANGUAGES.find((l) => l === raw.language) ?? fallbackLanguage;
    script = { inline: raw.inline, language };
  } else if (typeof raw.file === 'string' && raw.file.trim()) script = { file: raw.file.trim() };
  else throw new Error('Choose a script file.');
  const blankFolder = typeof input.cwd !== 'string' || input.cwd.trim() === '';
  // Everything but the command is checked like a run profile's.
  const { env, url } = validateProfileInput({ ...input, name, command: '-' });
  return {
    name,
    cwd: blankFolder ? undefined : validateFolder(input.cwd),
    ...(env ? { env } : {}),
    ...(url ? { url } : {}),
    script,
    hiddenFromAgents: input.hiddenFromAgents === true,
    newTerminal: input.newTerminal === true,
  };
}

/** The override that turns a detected profile into the edited one (only the changed fields). */
export function overrideFor(detected: DetectedProfile, edited: ValidProfileInput): ProfileOverride | null {
  const o: ProfileOverride = {};
  if (edited.name !== detected.name) o.name = edited.name;
  if (edited.command !== detected.command) o.command = edited.command;
  if (edited.cwd !== detected.cwd) o.cwd = edited.cwd;
  if (edited.env) o.env = edited.env;
  if (edited.url && edited.url !== detected.url) o.url = edited.url;
  return Object.keys(o).length > 0 ? o : null;
}

/** Finds a profile by id, or by name (case-insensitive) for agents. */
export function findProfile(profiles: RunProfile[], idOrName: string): RunProfile | undefined {
  const wanted = idOrName.trim();
  return (
    profiles.find((p) => p.id === wanted) ??
    profiles.find((p) => p.name.toLowerCase() === wanted.toLowerCase()) ??
    profiles.find((p) => `${p.name} (${p.framework ?? ''})`.toLowerCase() === wanted.toLowerCase())
  );
}
