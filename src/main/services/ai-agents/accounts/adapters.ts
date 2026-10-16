import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { AiAccountAgent } from '@shared/domain/ai-agents';

/** What an account folder shares with the main account (paths relative to the CLI's configuration folder). */
export interface SharedItem {
  name: string;
  /**
   * `dir`: a directory link (a junction on Windows: no admin rights or Developer Mode needed). `file`: a file link;
   * where Windows refuses it, a copy that follows the main account's file. `import`: a CLAUDE.md that imports the
   * main one (`@~/.claude/CLAUDE.md`) — works everywhere, and instructions for the account alone can be added below.
   */
  kind: 'dir' | 'file' | 'import';
}

export interface AccountContext {
  platform: NodeJS.Platform;
  /** The environment terminals start with (the user's own CLAUDE_CONFIG_DIR… point at the main account). */
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home folder. */
  home: string;
}

export interface AccountAdapter {
  agent: AiAccountAgent;
  /** The main account's folder (the value its variable would have), resolved like the CLI does. */
  mainHome(ctx: AccountContext): string;
  /** The folder the CLI keeps its files in, for an account folder (Gemini CLI: `<home>/.gemini`). */
  configRoot(home: string, ctx: AccountContext): string;
  shared: readonly SharedItem[];
  /** Files written once when the account is created in the shared setup (main config root → account config root). */
  seed: readonly Seed[];
}

/** A file made once from the main account's file (never its sign-in). */
export interface Seed {
  /** Relative to the account's config root. */
  name: string;
  /** Read from here (relative to the main config root, or computed for files outside it). */
  from: (mainRoot: string, ctx: AccountContext) => string;
  /** The account's content from the main one; undefined: nothing to write. */
  transform: (main: string) => string | undefined;
}

export const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

export function envValue(ctx: AccountContext, name: string): string | undefined {
  const key =
    ctx.platform === 'win32'
      ? Object.keys(ctx.env).find((k) => k.toUpperCase() === name.toUpperCase())
      : name in ctx.env
        ? name
        : undefined;
  const value = key === undefined ? undefined : ctx.env[key]?.trim();
  return value || undefined;
}

type Json = Record<string, unknown>;
const parseObject = (text: string): Json | undefined => {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
};

/** The main Claude Code folder: the first of CLAUDE_CONFIG_DIR (comma separated in some setups), else ~/.claude. */
const claudeMainHome = (ctx: AccountContext): string =>
  envValue(ctx, 'CLAUDE_CONFIG_DIR')?.split(',')[0]?.trim() || pathFor(ctx.platform).join(ctx.home, '.claude');

export const claudeAdapter: AccountAdapter = {
  agent: 'claude',
  mainHome: claudeMainHome,
  configRoot: (home) => home,
  shared: [
    { name: 'CLAUDE.md', kind: 'import' },
    { name: 'agents', kind: 'dir' },
    { name: 'skills', kind: 'dir' },
    { name: 'commands', kind: 'dir' },
    { name: 'output-styles', kind: 'dir' },
    { name: 'settings.json', kind: 'file' },
    { name: 'plugins/cache', kind: 'dir' },
    { name: 'plugins/marketplaces', kind: 'dir' },
    { name: 'plugins/installed_plugins.json', kind: 'file' },
  ],
  seed: [
    {
      // `.claude.json` holds the sign-in (`oauthAccount`), onboarding and project trust: only the MCP servers are
      // taken. Without CLAUDE_CONFIG_DIR the main one lives in the home folder.
      name: '.claude.json',
      from: (mainRoot, ctx) =>
        envValue(ctx, 'CLAUDE_CONFIG_DIR')
          ? pathFor(ctx.platform).join(mainRoot, '.claude.json')
          : pathFor(ctx.platform).join(ctx.home, '.claude.json'),
      transform: (main) => {
        const servers = parseObject(main)?.['mcpServers'];
        return servers && typeof servers === 'object'
          ? `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`
          : undefined;
      },
    },
    {
      // The marketplaces the shared plugins come from (their folders are shared).
      name: 'plugins/known_marketplaces.json',
      from: (mainRoot, ctx) => pathFor(ctx.platform).join(mainRoot, 'plugins', 'known_marketplaces.json'),
      transform: (main) => main,
    },
  ],
};

export const codexAdapter: AccountAdapter = {
  agent: 'codex',
  mainHome: (ctx) => envValue(ctx, 'CODEX_HOME') ?? pathFor(ctx.platform).join(ctx.home, '.codex'),
  configRoot: (home) => home,
  // Kept separate: auth.json (or the keyring entry, keyed by CODEX_HOME), sessions, history.jsonl, logs.
  shared: [
    { name: 'AGENTS.md', kind: 'file' },
    { name: 'config.toml', kind: 'file' },
    { name: 'prompts', kind: 'dir' },
    { name: 'skills', kind: 'dir' },
  ],
  seed: [],
};

const GEMINI_AUTH_KEYS = ['selectedAuthType', 'useExternalAuth'];

export const geminiAdapter: AccountAdapter = {
  agent: 'gemini',
  mainHome: (ctx) => envValue(ctx, 'GEMINI_CLI_HOME') ?? ctx.home,
  configRoot: (home, ctx) => pathFor(ctx.platform).join(home, '.gemini'),
  // Kept separate: oauth_creds.json, google_accounts.json, tmp/ (chats, shell history).
  shared: [
    { name: 'GEMINI.md', kind: 'file' },
    { name: 'commands', kind: 'dir' },
    { name: 'extensions', kind: 'dir' },
  ],
  seed: [
    {
      // settings.json also says how to sign in: copied once without that, so each account picks its own.
      name: 'settings.json',
      from: (mainRoot, ctx) => pathFor(ctx.platform).join(mainRoot, 'settings.json'),
      transform: (main) => {
        const settings = parseObject(main);
        if (!settings) return undefined;
        for (const key of GEMINI_AUTH_KEYS) delete settings[key];
        const security = settings['security'];
        if (security && typeof security === 'object' && !Array.isArray(security)) delete (security as Json)['auth'];
        return `${JSON.stringify(settings, null, 2)}\n`;
      },
    },
  ],
};

export const ACCOUNT_ADAPTERS: Record<AiAccountAgent, AccountAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};

/**
 * The macOS Keychain entry of Claude Code's sign-in for a CLAUDE_CONFIG_DIR: `Claude Code-credentials-` and the first
 * 8 hex characters of the folder's SHA-256 (the default folder has no suffix).
 */
export function claudeKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}
