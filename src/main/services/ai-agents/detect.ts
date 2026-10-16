import { posix, win32 } from 'node:path';
import {
  AI_AGENT_CATALOG,
  type AiAccount,
  type AiAccountAgent,
  type AiAgentKind,
  type DetectedAiAgent,
} from '@shared/domain/ai-agents';

/** I/O of the detection, injectable so it is unit-testable. */
export interface AiDetectDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** An executable on PATH. */
  which(name: string): Promise<string | null>;
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  /** Runs a command line through the shell (hidden window), stdout + stderr; null on failure or timeout. */
  run(commandLine: string, timeoutMs: number): Promise<string | null>;
  /** GET a local URL as JSON; null when nothing answers. */
  httpJson(url: string, timeoutMs: number): Promise<unknown>;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

async function readJson(deps: AiDetectDeps, path: string): Promise<Json | null> {
  const text = await deps.readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The claims of a JWT (not verified: only to show who is signed in). */
export function jwtClaims(token: string): Json | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function envValue(deps: AiDetectDeps, name: string): string | undefined {
  if (deps.platform !== 'win32') return str(deps.env[name]);
  const key = Object.keys(deps.env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : str(deps.env[key]);
}

const apiKeyFromEnv = (deps: AiDetectDeps, ...names: string[]): AiAccount[] => {
  const name = names.find((n) => envValue(deps, n));
  return name ? [{ label: name, method: 'api-key', detail: 'From the environment' }] : [];
};

function joinPath(deps: AiDetectDeps, ...parts: string[]): string {
  return (deps.platform === 'win32' ? win32 : posix).join(...parts);
}

const xdgData = (deps: AiDetectDeps) => envValue(deps, 'XDG_DATA_HOME') ?? joinPath(deps, deps.home, '.local', 'share');
const xdgConfig = (deps: AiDetectDeps) => envValue(deps, 'XDG_CONFIG_HOME') ?? joinPath(deps, deps.home, '.config');

// ── accounts per agent (only names, e-mail addresses and plans are read; tokens never leave the files) ──

/** The Claude Code sign-in stored in a configuration folder (`.claude.json` + `.credentials.json`). */
async function claudeLogin(deps: AiDetectDeps, configFile: string, configDir: string): Promise<AiAccount[]> {
  const config = await readJson(deps, configFile);
  const credentials = await readJson(deps, joinPath(deps, configDir, '.credentials.json'));
  const account = isObject(config?.['oauthAccount']) ? config['oauthAccount'] : undefined;
  const email = str(account?.['emailAddress']);
  if (!email) return [];
  const oauth = isObject(credentials?.['claudeAiOauth']) ? credentials['claudeAiOauth'] : undefined;
  const plan = str(oauth?.['subscriptionType']);
  const org = str(account?.['organizationName']);
  return [
    {
      label: email,
      method: 'oauth',
      ...(plan ? { plan: capitalize(plan) } : {}),
      ...(org && !org.includes(email) ? { detail: `Organization: ${org}` } : {}),
    },
  ];
}

async function claudeAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const dir = envValue(deps, 'CLAUDE_CONFIG_DIR')?.split(',')[0]?.trim();
  const out = await claudeLogin(
    deps,
    dir ? joinPath(deps, dir, '.claude.json') : joinPath(deps, deps.home, '.claude.json'),
    dir ?? joinPath(deps, deps.home, '.claude'),
  );
  out.push(...apiKeyFromEnv(deps, 'ANTHROPIC_API_KEY'));
  return out;
}

/** The Codex CLI sign-in in a CODEX_HOME (`auth.json`: a ChatGPT login's id token, or an API key). */
async function codexLogin(deps: AiDetectDeps, home: string): Promise<AiAccount[]> {
  const auth = await readJson(deps, joinPath(deps, home, 'auth.json'));
  const tokens = isObject(auth?.['tokens']) ? auth['tokens'] : undefined;
  const idToken = str(tokens?.['id_token']);
  if (idToken) {
    const claims = jwtClaims(idToken);
    const email = str(claims?.['email']);
    const openai = isObject(claims?.['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : {};
    const plan = str(openai['chatgpt_plan_type']);
    if (email) return [{ label: email, method: 'oauth', ...(plan ? { plan: capitalize(plan) } : {}) }];
  }
  if (str(auth?.['OPENAI_API_KEY'])) return [{ label: 'API key', method: 'api-key', detail: 'Codex auth.json' }];
  return [];
}

async function codexAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const login = await codexLogin(deps, envValue(deps, 'CODEX_HOME') ?? joinPath(deps, deps.home, '.codex'));
  return login.length ? login : apiKeyFromEnv(deps, 'OPENAI_API_KEY');
}

/** The Gemini CLI sign-in in a `.gemini` folder; null: none. */
async function geminiLogin(deps: AiDetectDeps, dir: string): Promise<AiAccount[] | null> {
  const settings = await readJson(deps, joinPath(deps, dir, 'settings.json'));
  const security = isObject(settings?.['security']) ? settings['security'] : undefined;
  const auth = isObject(security?.['auth']) ? security['auth'] : undefined;
  const selected = str(auth?.['selectedType']) ?? str(settings?.['selectedAuthType']);
  if (selected === 'gemini-api-key') return [{ label: 'GEMINI_API_KEY', method: 'api-key' }];
  if (selected === 'vertex-ai') return [{ label: 'Vertex AI', method: 'other', detail: 'Google Cloud credentials' }];
  const accounts = await readJson(deps, joinPath(deps, dir, 'google_accounts.json'));
  const active = str(accounts?.['active']);
  return active ? [{ label: active, method: 'oauth' }] : null;
}

/**
 * Who an added account is signed in with, from the files in its own folder (the environment does not count: an
 * account's terminals start without the user's API keys of Claude Code).
 */
export async function accountLogins(deps: AiDetectDeps, agent: AiAccountAgent, home: string): Promise<AiAccount[]> {
  switch (agent) {
    case 'claude':
      return claudeLogin(deps, joinPath(deps, home, '.claude.json'), home);
    case 'codex':
      return codexLogin(deps, home);
    case 'gemini':
      return (await geminiLogin(deps, joinPath(deps, home, '.gemini'))) ?? [];
  }
}

/** Gemini CLI keeps its files in `$GEMINI_CLI_HOME/.gemini` (default: the home folder). */
async function geminiAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const dir = joinPath(deps, envValue(deps, 'GEMINI_CLI_HOME') ?? deps.home, '.gemini');
  return (await geminiLogin(deps, dir)) ?? apiKeyFromEnv(deps, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
}

async function qwenAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const dir = joinPath(deps, deps.home, '.qwen');
  const settings = await readJson(deps, joinPath(deps, dir, 'settings.json'));
  const security = isObject(settings?.['security']) ? settings['security'] : undefined;
  const auth = isObject(security?.['auth']) ? security['auth'] : undefined;
  const selected = str(auth?.['selectedType']) ?? str(settings?.['selectedAuthType']);
  if (selected === 'openai')
    return [{ label: 'OpenAI-compatible API key', method: 'api-key', detail: 'Qwen Code settings' }];
  if (await deps.exists(joinPath(deps, dir, 'oauth_creds.json'))) return [{ label: 'Qwen account', method: 'oauth' }];
  return apiKeyFromEnv(deps, 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY');
}

async function copilotAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const dir = envValue(deps, 'COPILOT_HOME') ?? joinPath(deps, deps.home, '.copilot');
  const config = await readJson(deps, joinPath(deps, dir, 'config.json'));
  const users: AiAccount[] = [];
  const add = (u: unknown) => {
    if (!isObject(u)) return;
    const login = str(u['login']);
    if (!login || users.some((x) => x.label === login)) return;
    const host = str(u['host']);
    users.push({
      label: login,
      method: 'oauth',
      ...(host && !/^https:\/\/github\.com\/?$/.test(host) ? { detail: host } : {}),
    });
  };
  add(config?.['last_logged_in_user']);
  if (Array.isArray(config?.['logged_in_users'])) for (const u of config['logged_in_users']) add(u);
  return users.length ? users : apiKeyFromEnv(deps, 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN');
}

/** The GitHub CLI's accounts (hosts.yml: `github.com:` … `    user: login`). */
export function ghUsers(hostsYml: string): AiAccount[] {
  const out: AiAccount[] = [];
  let host: string | undefined;
  for (const line of hostsYml.split(/\r?\n/)) {
    const top = /^([^\s#][^:]*):\s*$/.exec(line);
    if (top) {
      host = top[1]!.trim();
      continue;
    }
    const user = /^\s{2,}user:\s*(\S+)\s*$/.exec(line);
    if (user && host)
      out.push({ label: user[1]!, method: 'oauth', ...(host !== 'github.com' ? { detail: host } : {}) });
  }
  return out;
}

async function ghCopilot(deps: AiDetectDeps): Promise<AiAccount[] | null> {
  const win = deps.platform === 'win32';
  const extensions = win
    ? joinPath(
        deps,
        envValue(deps, 'LOCALAPPDATA') ?? joinPath(deps, deps.home, 'AppData', 'Local'),
        'GitHub CLI',
        'extensions',
      )
    : joinPath(deps, xdgData(deps), 'gh', 'extensions');
  if (!(await deps.exists(joinPath(deps, extensions, 'gh-copilot')))) return null;
  const configDir =
    envValue(deps, 'GH_CONFIG_DIR') ??
    (win
      ? joinPath(deps, envValue(deps, 'APPDATA') ?? joinPath(deps, deps.home, 'AppData', 'Roaming'), 'GitHub CLI')
      : joinPath(deps, xdgConfig(deps), 'gh'));
  const hosts = await deps.readText(joinPath(deps, configDir, 'hosts.yml'));
  return hosts ? ghUsers(hosts) : [];
}

async function opencodeAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const auth = await readJson(deps, joinPath(deps, xdgData(deps), 'opencode', 'auth.json'));
  if (!auth) return [];
  return Object.entries(auth)
    .filter(([, v]) => isObject(v))
    .map(([provider, v]) => ({
      label: provider,
      method: (v as Json)['type'] === 'oauth' ? 'oauth' : 'api-key',
      detail: 'OpenCode provider',
    }));
}

async function grokAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const settings = await readJson(deps, joinPath(deps, deps.home, '.grok', 'user-settings.json'));
  if (str(settings?.['apiKey'])) {
    const base = str(settings?.['baseURL']);
    return [{ label: 'xAI API key', method: 'api-key', ...(base ? { detail: base } : {}) }];
  }
  return apiKeyFromEnv(deps, 'GROK_API_KEY', 'XAI_API_KEY');
}

async function cursorAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const config = await readJson(deps, joinPath(deps, deps.home, '.cursor', 'cli-config.json'));
  const info = isObject(config?.['authInfo']) ? config['authInfo'] : undefined;
  const email = str(info?.['email']);
  return email ? [{ label: email, method: 'oauth' }] : apiKeyFromEnv(deps, 'CURSOR_API_KEY');
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

async function kiroAccounts(deps: AiDetectDeps, path: string): Promise<AiAccount[]> {
  const out = await deps.run(`${quote(deps, path)} whoami`, 8000);
  const email = out ? EMAIL.exec(out)?.[0] : undefined;
  return email ? [{ label: email, method: 'oauth' }] : [];
}

async function gooseAccounts(deps: AiDetectDeps): Promise<AiAccount[]> {
  const config = await deps.readText(joinPath(deps, xdgConfig(deps), 'goose', 'config.yaml'));
  const provider = config ? /^GOOSE_PROVIDER:\s*["']?([^"'\s]+)/m.exec(config)?.[1] : undefined;
  return provider ? [{ label: provider, method: 'other', detail: 'Goose provider' }] : [];
}

const AIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY'];

async function accountsOf(kind: AiAgentKind, deps: AiDetectDeps, path: string): Promise<AiAccount[]> {
  switch (kind.id) {
    case 'claude':
      return claudeAccounts(deps);
    case 'codex':
      return codexAccounts(deps);
    case 'gemini':
      return geminiAccounts(deps);
    case 'qwen':
      return qwenAccounts(deps);
    case 'copilot':
      return copilotAccounts(deps);
    case 'opencode':
      return opencodeAccounts(deps);
    case 'grok':
      return grokAccounts(deps);
    case 'cursor':
      return cursorAccounts(deps);
    case 'kiro':
      return kiroAccounts(deps, path);
    case 'kimi':
      return apiKeyFromEnv(deps, 'KIMI_API_KEY', 'MOONSHOT_API_KEY');
    case 'amp':
      return apiKeyFromEnv(deps, 'AMP_API_KEY');
    case 'droid':
      return apiKeyFromEnv(deps, 'FACTORY_API_KEY');
    case 'goose':
      return gooseAccounts(deps);
    case 'aider':
      return AIDER_KEYS.filter((k) => envValue(deps, k)).map((k) => ({
        label: k,
        method: 'api-key' as const,
        detail: 'From the environment',
      }));
    default:
      return [];
  }
}

function quote(deps: AiDetectDeps, path: string): string {
  if (!/[\s"'&()^%!]/.test(path)) return path;
  return deps.platform === 'win32' ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The first line of `--version` that looks like a version. */
export function versionLine(output: string | null): string | undefined {
  if (!output) return undefined;
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.find((l) => /\d+\.\d+/.test(l)) ?? lines[0])?.slice(0, 80);
}

// ── local model runtimes ──

async function ollama(deps: AiDetectDeps, path: string | null): Promise<DetectedAiAgent | null> {
  const configured = envValue(deps, 'OLLAMA_HOST');
  const url = configured
    ? /^https?:\/\//.test(configured)
      ? configured.replace(/\/+$/, '')
      : `http://${configured.replace(/^0\.0\.0\.0/, '127.0.0.1')}`
    : 'http://127.0.0.1:11434';
  const tags = await deps.httpJson(`${url}/api/tags`, 1500);
  const models =
    isObject(tags) && Array.isArray(tags['models'])
      ? tags['models'].map((m) => (isObject(m) ? str(m['name']) : undefined)).filter((m): m is string => !!m)
      : undefined;
  if (!path && !models) return null;
  return {
    id: 'ollama',
    name: 'Ollama',
    command: 'ollama',
    category: 'runtime',
    ...(path ? { path } : {}),
    accounts: [{ label: 'Local models', method: 'local' }],
    running: models !== undefined,
    models: models ?? [],
    url,
  };
}

async function llamaCpp(deps: AiDetectDeps, path: string | null): Promise<DetectedAiAgent | null> {
  const url = 'http://127.0.0.1:8080';
  // `/props` is llama-server's own endpoint: another app on port 8080 is not mistaken for it.
  const props = await deps.httpJson(`${url}/props`, 1500);
  const running = isObject(props) && ('default_generation_settings' in props || 'build_info' in props);
  let models: string[] = [];
  if (running) {
    const list = await deps.httpJson(`${url}/v1/models`, 1500);
    if (isObject(list) && Array.isArray(list['data']))
      models = list['data'].map((m) => (isObject(m) ? str(m['id']) : undefined)).filter((m): m is string => !!m);
  }
  if (!path && !running) return null;
  return {
    id: 'llamacpp',
    name: 'llama.cpp server',
    command: 'llama-server',
    category: 'runtime',
    ...(path ? { path } : {}),
    accounts: [{ label: 'Local models', method: 'local' }],
    running,
    models,
    url,
  };
}

/** Every known agent found on this computer, with its version and the accounts it is signed in with. */
export async function detectAiAgents(deps: AiDetectDeps): Promise<DetectedAiAgent[]> {
  const found = await Promise.all(
    AI_AGENT_CATALOG.map(async (kind): Promise<DetectedAiAgent | null> => {
      let path: string | null = null;
      for (const exe of kind.executables) {
        path = await deps.which(exe);
        if (path) break;
      }
      if (kind.id === 'ollama') return ollama(deps, path);
      if (kind.id === 'llamacpp') return llamaCpp(deps, path);
      if (!path) return null;
      if (kind.id === 'gh-copilot') {
        const accounts = await ghCopilot(deps);
        if (accounts === null) return null;
        return { id: kind.id, name: kind.name, command: kind.command, category: 'agent', path, accounts, legacy: true };
      }
      const [version, accounts] = await Promise.all([
        deps.run(`${quote(deps, path)} --version`, 15_000).then(versionLine),
        accountsOf(kind, deps, path).catch(() => []),
      ]);
      return {
        id: kind.id,
        name: kind.name,
        command: kind.command,
        category: kind.category,
        path,
        ...(version ? { version } : {}),
        accounts,
        ...(kind.legacy ? { legacy: true } : {}),
      };
    }),
  );
  return found.filter((a): a is DetectedAiAgent => a !== null);
}
