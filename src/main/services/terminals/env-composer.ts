export type EnvLayer = Readonly<Record<string, string | null | undefined>>;

/** Variables stripped from the inherited environment (other terminals/IDEs, Electron, nested Claude Code). */
const STRIP_EXACT = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
  'WT_PROFILE_ID',
  'TERMINAL_EMULATOR',
  'ITERM_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'OXYTOCIN_E2E',
  'OXYTOCIN_USER_DATA_DIR',
  'OXYTOCIN_INSPECT_HOSTS',
  'ELECTRON_RENDERER_URL',
]);
const STRIP_PREFIXES = ['ELECTRON_', 'CHROME_', 'VSCODE_', 'KITTY_', 'ALACRITTY_', 'WEZTERM_', 'GHOSTTY_', 'KONSOLE_'];

export function shouldStripInherited(key: string, opts: { dev: boolean }): boolean {
  const upper = key.toUpperCase();
  if (STRIP_EXACT.has(upper)) return true;
  if (STRIP_PREFIXES.some((p) => upper.startsWith(p))) return true;
  // NODE_OPTIONS is usually set by dev tooling when running from source; keep the user's own in production.
  if (opts.dev && upper === 'NODE_OPTIONS') return true;
  return false;
}

/** An environment map that is case-insensitive on Windows (`Path` and `PATH` are the same variable). */
export class EnvMap {
  private readonly values = new Map<string, { key: string; value: string }>();

  constructor(private readonly caseInsensitive: boolean) {}

  private norm(key: string): string {
    return this.caseInsensitive ? key.toUpperCase() : key;
  }

  get(key: string): string | undefined {
    return this.values.get(this.norm(key))?.value;
  }

  /** Sets a value; `null` deletes. Keeps the original spelling of an existing key (e.g. `Path`). */
  set(key: string, value: string | null | undefined): void {
    const k = this.norm(key);
    if (value === null) {
      this.values.delete(k);
      return;
    }
    if (value === undefined) return;
    const existing = this.values.get(k);
    this.values.set(k, { key: existing?.key ?? key, value });
  }

  delete(key: string): void {
    this.values.delete(this.norm(key));
  }

  toRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { key, value } of this.values.values()) out[key] = value;
    return out;
  }
}

/** Expands `${env:NAME}` against the environment composed so far (unknown variables become empty). */
export function expandEnvReferences(value: string, env: EnvMap): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => env.get(name) ?? '');
}

export interface ComposeEnvInput {
  platform: NodeJS.Platform;
  /** Step 1: the base environment (main's env; on macOS/Linux resolved from the login shell). */
  base: EnvLayer;
  dev: boolean;
  appVersion: string;
  projectId: string;
  terminalId: string;
  /** Steps 4–7, applied in order: settings `terminal.env`, project env, plugin contributions, profile env. */
  layers: readonly EnvLayer[];
}

/** Composes a terminal environment (docs/plan/04-terminals.md §2.3). Later layers win; `null` removes. */
export function composeEnv(input: ComposeEnvInput): Record<string, string> {
  const env = new EnvMap(input.platform === 'win32');
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || value === null) continue;
    if (shouldStripInherited(key, { dev: input.dev })) continue;
    env.set(key, value);
  }
  env.set('TERM_PROGRAM', 'Oxytocin');
  env.set('TERM_PROGRAM_VERSION', input.appVersion);
  env.set('COLORTERM', 'truecolor');
  env.set('OXYTOCIN', '1');
  env.set('OXYTOCIN_PROJECT_ID', input.projectId);
  env.set('OXYTOCIN_TERMINAL_ID', input.terminalId);
  if (input.platform !== 'win32') {
    env.set('TERM', 'xterm-256color');
    if (input.platform === 'darwin' && !env.get('LANG')) env.set('LANG', 'en_US.UTF-8');
  }
  for (const layer of input.layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      env.set(key, value === null ? null : expandEnvReferences(value, env));
    }
  }
  return env.toRecord();
}
