import { z } from 'zod';
import { type Platform, TerminalProfileSchema } from './terminal-profile';

interface SettingDefinition<S extends z.ZodType> {
  schema: S;
  default: z.output<S> | ((platform: Platform) => z.output<S>);
  description?: string;
}

const def = <S extends z.ZodType>(
  schema: S,
  defaultValue: SettingDefinition<S>['default'],
  description?: string,
): SettingDefinition<S> =>
  description ? { schema, default: defaultValue, description } : { schema, default: defaultValue };

const DEFAULT_IGNORED_FOLDERS = [
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vs',
  'coverage',
];

/** Core settings schema (docs/plan/09-persistence-settings.md §3.2). Keys are flat, dotted, like VS Code. */
export const CORE_SETTINGS = {
  'appearance.theme': def(z.enum(['dark', 'light', 'system']), 'dark'),
  'appearance.uiZoom': def(z.number().min(0.8).max(1.5), 1),
  'appearance.reduceMotion': def(z.boolean(), false),
  'terminal.defaultProfile.windows': def(z.string().nullable(), null),
  'terminal.defaultProfile.osx': def(z.string().nullable(), null),
  'terminal.defaultProfile.linux': def(z.string().nullable(), null),
  'terminal.profiles': def(z.array(TerminalProfileSchema), []),
  'terminal.hiddenProfiles': def(z.array(z.string()), []),
  'terminal.fontFamily': def(z.string().min(1), (p) =>
    p === 'darwin' ? 'SF Mono, JetBrains Mono, Menlo, monospace' : 'Cascadia Mono, JetBrains Mono, Consolas, monospace',
  ),
  'terminal.fontSize': def(z.number().min(8).max(32), 13),
  'terminal.lineHeight': def(z.number().min(1).max(2), 1.2),
  'terminal.cursorStyle': def(z.enum(['bar', 'block', 'underline']), 'bar'),
  'terminal.cursorBlink': def(z.boolean(), true),
  'terminal.scrollback': def(z.number().int().min(1000).max(100000), 5000),
  'terminal.renderer': def(z.enum(['dom', 'webgl']), 'dom'),
  'terminal.copyOnSelect': def(z.boolean(), false),
  'terminal.ctrlCBehavior': def(z.enum(['copyIfSelection', 'alwaysSigint']), 'copyIfSelection'),
  'terminal.ctrlVBehavior': def(z.enum(['paste', 'passthrough']), 'paste'),
  'terminal.rightClickBehavior': def(z.enum(['copyPaste', 'menu']), (p) => (p === 'win32' ? 'copyPaste' : 'menu')),
  'terminal.shiftEnterSequence': def(z.string(), '\u001b\r'),
  'terminal.confirmMultilinePaste': def(z.boolean(), true),
  'terminal.osc52': def(z.enum(['allow', 'ask', 'deny']), 'allow'),
  'terminal.confirmOnKill': def(z.enum(['always', 'whenProcessRunning', 'never']), 'whenProcessRunning'),
  'terminal.confirmOnQuit': def(z.boolean(), true),
  'terminal.closeOnExit': def(z.enum(['never', 'ifClean', 'always']), 'ifClean'),
  'terminal.restoreScrollback': def(z.boolean(), true),
  'terminal.persistScrollbackLines': def(z.number().int().min(0).max(100000), 1000),
  'terminal.env': def(z.record(z.string(), z.string().nullable()), {}),
  'terminal.windows.useBundledConpty': def(z.boolean(), true),
  'terminal.macOptionIsMeta': def(z.boolean(), false),
  'terminal.fileLinkAction': def(z.enum(['smart', 'editor', 'diff']), 'smart'),
  'terminal.dimInactive': def(z.boolean(), false),
  'terminal.screenReaderMode': def(z.boolean(), false),
  'terminal.shellIntegration': def(z.boolean(), true),
  'terminal.images': def(z.boolean(), false),
  'workspace.keepAliveProjects': def(z.number().int().min(1).max(10), 4),
  'workspace.restoreOnStartup': def(z.boolean(), true),
  'workspace.openLastProject': def(z.boolean(), true),
  'git.enabled': def(z.boolean(), true),
  'git.path': def(z.string().nullable(), null),
  'git.ignoredFolders': def(z.array(z.string()), DEFAULT_IGNORED_FOLDERS),
  'git.maxFiles': def(z.number().int().min(100).max(100000), 5000),
  'git.watchInactiveProjects': def(z.boolean(), true),
  'git.periodicRefreshSeconds': def(z.number().int().min(0).max(300), 15),
  'git.diff.sideBySide': def(z.boolean(), true),
  'git.diff.ignoreWhitespace': def(z.boolean(), false),
  'git.diff.hideUnchangedRegions': def(z.boolean(), true),
  'git.diff.maxFileSizeMb': def(z.number().min(0.1).max(100), 2),
  'git.confirmDiscard': def(z.boolean(), true),
  'editor.preset': def(
    z.enum([
      'auto',
      'vscode',
      'cursor',
      'windsurf',
      'zed',
      'jetbrains',
      'sublime',
      'notepadpp',
      'terminal',
      'system',
      'custom',
    ]),
    'auto',
  ),
  'editor.command': def(z.string(), ''),
  'notifications.os': def(z.boolean(), true),
  'notifications.agentWaiting': def(z.boolean(), true),
  'notifications.agentFinished': def(z.boolean(), true),
  'notifications.agentFinishedMinSeconds': def(z.number().min(0), 30),
  'notifications.processError': def(z.boolean(), true),
  'notifications.flashTaskbar': def(z.boolean(), true),
  'notifications.doNotDisturb': def(z.boolean(), false),
  'plugins.enabled': def(z.record(z.string(), z.boolean()), {}),
  'plugins.developerMode': def(z.boolean(), false),
  'plugins.devPaths': def(z.array(z.string()), []),
  'diagnostics.logLevel': def(z.enum(['error', 'warn', 'info', 'debug']), 'info'),
} as const;

export type CoreSettingKey = keyof typeof CORE_SETTINGS;
export type CoreSettings = { [K in CoreSettingKey]: z.output<(typeof CORE_SETTINGS)[K]['schema']> };
/** Core settings plus any other keys found in settings.json (plugin settings, unknown keys are preserved). */
export type Settings = CoreSettings & { readonly [key: string]: unknown };

export const CORE_SETTING_KEYS = Object.keys(CORE_SETTINGS) as CoreSettingKey[];

/** Renamed keys: old → new. Applied when reading settings.json. */
export const RENAMED_SETTING_KEYS: Readonly<Record<string, CoreSettingKey>> = {
  'terminal.rendererType': 'terminal.renderer',
};

export interface SettingsProblem {
  key: string;
  message: string;
}

export function defaultSettingValue<K extends CoreSettingKey>(key: K, platform: Platform): CoreSettings[K] {
  const d = CORE_SETTINGS[key].default as CoreSettings[K] | ((p: Platform) => CoreSettings[K]);
  const value = typeof d === 'function' ? d(platform) : d;
  return structuredClone(value);
}

export function defaultSettings(platform: Platform): CoreSettings {
  const out: Record<string, unknown> = {};
  for (const key of CORE_SETTING_KEYS) out[key] = defaultSettingValue(key, platform);
  return out as CoreSettings;
}

/**
 * Validates user settings key by key: invalid values fall back to defaults and are reported as problems;
 * unknown keys are kept as-is (they may belong to a disabled plugin).
 */
export function resolveSettings(raw: unknown, platform: Platform): { settings: Settings; problems: SettingsProblem[] } {
  const problems: SettingsProblem[] = [];
  const settings: Record<string, unknown> = defaultSettings(platform);
  if (raw === undefined || raw === null) return { settings: settings as Settings, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ key: '', message: 'settings.json must contain a JSON object' });
    return { settings: settings as Settings, problems };
  }
  const input: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [oldKey, newKey] of Object.entries(RENAMED_SETTING_KEYS)) {
    if (oldKey in input) {
      if (!(newKey in input)) input[newKey] = input[oldKey];
      delete input[oldKey];
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const definition = (CORE_SETTINGS as Record<string, SettingDefinition<z.ZodType>>)[key];
    if (!definition) {
      settings[key] = value;
      continue;
    }
    const parsed = definition.schema.safeParse(value);
    if (parsed.success) {
      settings[key] = parsed.data;
    } else {
      problems.push({ key, message: parsed.error.issues.map((i) => i.message).join('; ') });
    }
  }
  return { settings: settings as Settings, problems };
}

export const SettingsSchema = z.record(z.string(), z.unknown()) as unknown as z.ZodType<Settings>;
export const SettingsPatchSchema = z.record(z.string(), z.unknown());
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
