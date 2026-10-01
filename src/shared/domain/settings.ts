import { z } from 'zod';
import { type Platform, TerminalProfileSchema } from './terminal-profile';
import { UpdateChannelSchema } from './updates';

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

/** Core settings schema. Keys are flat, dotted, like VS Code. */
export const CORE_SETTINGS = {
  'appearance.theme': def(
    z.enum(['dark', 'light', 'system']),
    'dark',
    'Color theme of the window, terminals and diffs. "system" follows the operating system.',
  ),
  'appearance.uiZoom': def(z.number().min(0.8).max(1.5), 1, 'Scale of the whole interface (0.8–1.5).'),
  'appearance.reduceMotion': def(
    z.boolean(),
    false,
    'Turns off animations (also done automatically when the operating system asks for reduced motion).',
  ),
  'terminal.defaultProfile.windows': def(
    z.string().nullable(),
    null,
    'Profile for new terminals on Windows. Empty = detected automatically.',
  ),
  'terminal.defaultProfile.osx': def(
    z.string().nullable(),
    null,
    'Profile for new terminals on macOS. Empty = detected automatically.',
  ),
  'terminal.defaultProfile.linux': def(
    z.string().nullable(),
    null,
    'Profile for new terminals on Linux. Empty = detected automatically.',
  ),
  'terminal.profiles': def(
    z.array(TerminalProfileSchema),
    [],
    'Your own terminal profiles (shells or agents with arguments, environment and icon).',
  ),
  'terminal.hiddenProfiles': def(z.array(z.string()), [], 'Ids of detected profiles that are not offered.'),
  'terminal.fontFamily': def(
    z.string().min(1),
    (p) =>
      p === 'darwin'
        ? 'SF Mono, JetBrains Mono, Menlo, monospace'
        : 'Cascadia Mono, JetBrains Mono, Consolas, monospace',
    'Font of terminals (CSS font-family list).',
  ),
  'terminal.fontSize': def(z.number().min(8).max(32), 13, 'Font size of terminals in pixels.'),
  'terminal.lineHeight': def(z.number().min(1).max(2), 1.2, 'Line height of terminals (multiple of the font size).'),
  'terminal.cursorStyle': def(z.enum(['bar', 'block', 'underline']), 'bar', 'Shape of the terminal cursor.'),
  'terminal.cursorBlink': def(z.boolean(), true, 'Whether the terminal cursor blinks.'),
  'terminal.scrollback': def(z.number().int().min(1000).max(100000), 5000, 'Lines kept in each terminal buffer.'),
  'terminal.renderer': def(
    z.enum(['dom', 'webgl']),
    'dom',
    'Terminal renderer. WebGL is faster for very busy output; DOM is the most compatible.',
  ),
  'terminal.copyOnSelect': def(z.boolean(), false, 'Copies selected terminal text to the clipboard automatically.'),
  'terminal.ctrlCBehavior': def(
    z.enum(['copyIfSelection', 'alwaysSigint']),
    'copyIfSelection',
    'Ctrl+C copies when text is selected, or always sends an interrupt to the shell.',
  ),
  'terminal.ctrlVBehavior': def(
    z.enum(['paste', 'passthrough']),
    'paste',
    'Ctrl+V pastes, or is passed through to the program in the terminal.',
  ),
  'terminal.rightClickBehavior': def(
    z.enum(['copyPaste', 'menu']),
    (p) => (p === 'win32' ? 'copyPaste' : 'menu'),
    'Right click copies the selection or pastes, or opens the context menu.',
  ),
  'terminal.shiftEnterSequence': def(
    z.string(),
    '\u001b\r',
    'Sequence sent for Shift+Enter (a new line in Claude Code). Empty sends a plain Enter.',
  ),
  'terminal.confirmMultilinePaste': def(
    z.boolean(),
    true,
    'Asks before pasting several lines into a shell without bracketed paste mode.',
  ),
  'terminal.osc52': def(
    z.enum(['allow', 'ask', 'deny']),
    'allow',
    'Whether programs in terminals may write to the clipboard (OSC 52).',
  ),
  'terminal.confirmOnKill': def(
    z.enum(['always', 'whenProcessRunning', 'never']),
    'whenProcessRunning',
    'Asks before closing a terminal.',
  ),
  'terminal.confirmOnQuit': def(z.boolean(), true, 'Asks before quitting while processes or agents are running.'),
  'terminal.closeOnExit': def(
    z.enum(['never', 'ifClean', 'always']),
    'ifClean',
    'Closes the panel when its process exits.',
  ),
  'terminal.restoreScrollback': def(
    z.boolean(),
    true,
    'Saves terminal contents on quit and shows them again after a restart.',
  ),
  'terminal.persistScrollbackLines': def(
    z.number().int().min(0).max(100000),
    1000,
    'Lines per terminal saved on quit.',
  ),
  'terminal.env': def(
    z.record(z.string(), z.string().nullable()),
    {},
    'Extra environment variables for new terminals; null removes a variable.',
  ),
  'terminal.windows.useBundledConpty': def(
    z.boolean(),
    true,
    'Uses the ConPTY bundled with Oxytocin instead of the system one (applies to new terminals).',
  ),
  'terminal.macOptionIsMeta': def(z.boolean(), false, 'Option acts as Meta in terminals (for Emacs-style shortcuts).'),
  'terminal.fileLinkAction': def(
    z.enum(['smart', 'editor', 'diff']),
    'smart',
    'What Ctrl+click on a file path does: show the diff when the file changed, otherwise open it in the editor.',
  ),
  'terminal.dimInactive': def(z.boolean(), false, 'Dims terminals that do not have focus.'),
  'terminal.screenReaderMode': def(z.boolean(), false, 'Optimizes terminals for screen readers.'),
  'terminal.shellIntegration': def(
    z.boolean(),
    true,
    'Injects shell integration (current folder, command boundaries) into supported shells (applies to new terminals).',
  ),
  'terminal.images': def(z.boolean(), false, 'Shows inline images (Sixel, iTerm2 protocol) in terminals.'),
  'terminal.fileLinks.open': def(
    z.enum(['preview', 'editor']),
    'preview',
    'Where Ctrl/⌘+click on a file path in a terminal opens it: a preview tab (Markdown rendered, code highlighted) or the editor. Shift inverts the choice.',
  ),
  'workspace.keepAliveProjects': def(
    z.number().int().min(1).max(10),
    4,
    'Projects whose layouts stay mounted for instant switching.',
  ),
  'workspace.restoreOnStartup': def(z.boolean(), true, 'Restores layouts and terminals when Oxytocin starts.'),
  'workspace.openLastProject': def(z.boolean(), true, 'Opens the last active project at start-up.'),
  'scratchpad.fontFamily': def(
    z.enum(['mono', 'sans', 'serif']),
    'mono',
    'Font of the scratchpad: monospace (like the terminal), sans-serif (like the interface) or serif.',
  ),
  'scratchpad.fontSize': def(z.number().int().min(9).max(28), 12, 'Font size of the scratchpad in pixels.'),
  'scratchpad.lineHeight': def(z.number().min(1).max(2.5), 1.5, 'Line height of the scratchpad (1–2.5).'),
  'scratchpad.wordWrap': def(z.boolean(), true, 'Wraps long lines in the scratchpad instead of scrolling sideways.'),
  'scratchpad.formattingToolbar': def(
    z.boolean(),
    true,
    'Shows the Markdown formatting toolbar (bold, italic, code, lists…) above the scratchpad.',
  ),
  'scratchpad.continueLists': def(
    z.boolean(),
    true,
    'Enter at the end of a list item starts the next item ("- ", "2. ", "- [ ] ").',
  ),
  'scratchpad.spellCheck': def(z.boolean(), false, 'Underlines spelling mistakes in the scratchpad.'),
  'git.enabled': def(z.boolean(), true, 'Shows repository changes in the CHANGES section.'),
  'git.path': def(z.string().nullable(), null, 'Path to the git executable. Empty = found automatically.'),
  'git.ignoredFolders': def(
    z.array(z.string()),
    DEFAULT_IGNORED_FOLDERS,
    'Folders the file watcher ignores (one per line).',
  ),
  'git.maxFiles': def(z.number().int().min(100).max(100000), 5000, 'Maximum number of changed files shown.'),
  'git.watchInactiveProjects': def(
    z.boolean(),
    true,
    'Keeps watching projects with background terminals (paused after 10 minutes without activity).',
  ),
  'git.periodicRefreshSeconds': def(
    z.number().int().min(0).max(300),
    15,
    'Refreshes the status every N seconds as a safety net; 0 turns it off.',
  ),
  'git.diff.sideBySide': def(z.boolean(), true, 'Shows diffs side by side instead of inline.'),
  'git.diff.ignoreWhitespace': def(z.boolean(), false, 'Ignores whitespace-only changes in diffs.'),
  'git.diff.hideUnchangedRegions': def(z.boolean(), true, 'Collapses unchanged regions in diffs.'),
  'git.diff.maxFileSizeMb': def(z.number().min(0.1).max(100), 2, 'Files larger than this are not diffed.'),
  'git.confirmDiscard': def(z.boolean(), true, 'Asks before discarding changes.'),
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
    'Editor used by "Open in editor". "auto" picks the first one found.',
  ),
  'editor.command': def(
    z.string(),
    '',
    'Command for the "custom" and "terminal" presets; placeholders ${file}, ${line}, ${column}, ${projectRoot}.',
  ),
  'notifications.os': def(z.boolean(), true, 'Shows system notifications.'),
  'notifications.agentWaiting': def(z.boolean(), true, 'Notifies when an agent waits for you.'),
  'notifications.agentFinished': def(z.boolean(), true, 'Notifies when an agent finishes a longer task.'),
  'notifications.agentFinishedMinSeconds': def(
    z.number().min(0),
    30,
    'Minimum task length (seconds) for a "finished" notification.',
  ),
  'notifications.commandFinished': def(
    z.boolean(),
    true,
    'Notifies when a long command finishes in a terminal you are not looking at (needs shell integration).',
  ),
  'notifications.commandFinishedMinSeconds': def(
    z.number().min(0),
    30,
    'Minimum command length (seconds) for a "command finished" notification.',
  ),
  'notifications.processError': def(z.boolean(), true, 'Notifies when a process exits with an error.'),
  'notifications.flashTaskbar': def(
    z.boolean(),
    true,
    'Flashes the taskbar button (Windows) or bounces the dock icon (macOS) when attention is needed.',
  ),
  'notifications.doNotDisturb': def(z.boolean(), false, 'Silences all notifications.'),
  'plugins.enabled': def(
    z.record(z.string(), z.boolean()),
    {},
    'Plugins turned on or off (managed in the Plugins panel).',
  ),
  'plugins.developerMode': def(
    z.boolean(),
    false,
    'Loads plugins from development folders and reloads them on changes.',
  ),
  'plugins.devPaths': def(z.array(z.string()), [], 'Development plugin folders (one per line).'),
  'mcp.enabled': def(
    z.boolean(),
    true,
    "Runs Oxytocin's MCP server (127.0.0.1 only, token protected): AI agents such as Claude Code use Oxytocin's tools and the tools of your plugins through it.",
  ),
  'mcp.port': def(
    z.number().int().min(1024).max(65535),
    47287,
    'Local port of the MCP server. After changing it, connect Claude Code again (Agent tools).',
  ),
  'mcp.claudeCommand': def(
    z.string().min(1),
    'claude',
    'The Claude Code command used to connect it to the MCP server (a name on PATH or a full path).',
  ),
  'mcp.tools.disabled': def(z.array(z.string().max(64)), [], 'Tools agents cannot see (managed in Agent tools).'),
  'mcp.tools.policy': def(
    z.record(z.string().max(64), z.enum(['allow', 'ask', 'deny'])),
    {},
    'Per tool: runs without asking, asks you first, or is blocked (managed in Agent tools).',
  ),
  'ensemble.worktreeRoot': def(
    z.string().nullable(),
    null,
    'Folder for the git worktrees of Ensemble tasks (one per task). Empty = next to the repository, in "<repository>.worktrees".',
  ),
  'ensemble.commands': def(
    z.partialRecord(z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode']), z.string().max(2000)),
    {},
    'The command Ensemble starts per CLI when it is not the default ("claude", "codex", "gemini", "opencode"), e.g. a full path.',
  ),
  'updates.checkAutomatically': def(
    z.boolean(),
    true,
    'Checks for new versions at start and every 6 hours and downloads them in the background. Updates install when you quit or restart Oxytocin.',
  ),
  'updates.channel': def(UpdateChannelSchema, 'latest', 'Release channel: "beta" also offers pre-release versions.'),
  'diagnostics.logLevel': def(z.enum(['error', 'warn', 'info', 'debug']), 'info', 'Detail of the log files.'),
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
