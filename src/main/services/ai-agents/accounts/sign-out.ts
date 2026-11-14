import type { AiAccountAgent } from '@shared/domain/ai-agents';
import { OxyError } from '@shared/errors';
import { ACCOUNT_ADAPTERS, type AccountContext, claudeKeychainService, envValue, pathFor } from './adapters';
import type { ProvisionFs } from './provisioner';

export interface SignOutDeps extends AccountContext {
  fs: ProvisionFs;
  /** macOS: removes a Keychain entry (Claude Code's sign-in). */
  deleteKeychainEntry?: (service: string) => Promise<void>;
}

type Json = Record<string, unknown>;

function parseObject(text: string | null): Json | undefined {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}

async function removeFile(deps: SignOutDeps, path: string, removed: string[]): Promise<void> {
  if ((await deps.fs.kind(path)) !== 'file') return;
  await deps.fs.unlink(path);
  removed.push(path);
}

/**
 * Signs the main account of an agent CLI out, the way its own logout does: only the sign-in is removed (Claude Code:
 * `.credentials.json`, `oauthAccount` in `.claude.json` and the macOS Keychain entry; Codex CLI: `auth.json`; Gemini
 * CLI: `oauth_creds.json` and the active Google account). Settings, instructions, skills, plugins, sessions and
 * history stay, so the accounts added in the shared setup keep working. Returns the files changed; throws when there
 * was no sign-in to remove.
 */
export async function signOutMainAccount(agent: AiAccountAgent, deps: SignOutDeps): Promise<string[]> {
  const p = pathFor(deps.platform);
  const mainHome = ACCOUNT_ADAPTERS[agent].mainHome(deps);
  const removed: string[] = [];
  switch (agent) {
    case 'claude': {
      const configFile = envValue(deps, 'CLAUDE_CONFIG_DIR')
        ? p.join(mainHome, '.claude.json')
        : p.join(deps.home, '.claude.json');
      const config = parseObject(await deps.fs.readText(configFile));
      if (config && 'oauthAccount' in config) {
        delete config['oauthAccount'];
        await deps.fs.replaceText(configFile, `${JSON.stringify(config, null, 2)}\n`);
        removed.push(configFile);
      }
      await removeFile(deps, p.join(mainHome, '.credentials.json'), removed);
      if (deps.platform === 'darwin' && deps.deleteKeychainEntry) {
        const service = envValue(deps, 'CLAUDE_CONFIG_DIR')
          ? claudeKeychainService(mainHome)
          : 'Claude Code-credentials';
        await deps.deleteKeychainEntry(service).catch(() => undefined);
        if (removed.length > 0) removed.push(`Keychain: ${service}`);
      }
      break;
    }
    case 'codex':
      await removeFile(deps, p.join(mainHome, 'auth.json'), removed);
      break;
    case 'gemini': {
      const root = ACCOUNT_ADAPTERS.gemini.configRoot(mainHome, deps);
      await removeFile(deps, p.join(root, 'oauth_creds.json'), removed);
      const accountsFile = p.join(root, 'google_accounts.json');
      const accounts = parseObject(await deps.fs.readText(accountsFile));
      const active = accounts?.['active'];
      if (accounts && typeof active === 'string' && active) {
        const old: unknown[] = Array.isArray(accounts['old'])
          ? (accounts['old'] as unknown[]).filter((o) => o !== active)
          : [];
        await deps.fs.replaceText(
          accountsFile,
          `${JSON.stringify({ ...accounts, active: null, old: [...old, active] }, null, 2)}\n`,
        );
        removed.push(accountsFile);
      }
      break;
    }
  }
  if (removed.length === 0)
    throw new OxyError('NOT_FOUND', `No sign-in was found in ${mainHome}: the main account is not signed in there.`);
  return removed;
}
