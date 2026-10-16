import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ACCOUNT_LAUNCH_PREFIX,
  AI_ACCOUNT_AGENTS,
  AI_ACCOUNT_HOME_VARIABLES,
  AI_AGENT_CATALOG,
  AI_PROFILE_SECRET_SCOPE,
  type AgentAccount,
  type AgentAccountMode,
  AgentAccountSchema,
  type AiAccountAgent,
  AiAccountSchema,
  type AiAgentsState,
  type AiProfile,
  AiProfileSchema,
  accountEnv,
  accountSlug,
  aiAccountLaunchId,
  DetectedAiAgentSchema,
  profileEnv,
  validateAccountName,
  validateProfiles,
} from '@shared/domain/ai-agents';
import type { SecretChange } from '@shared/domain/project-resources';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import type { Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { SecretStore } from '../secrets/secret-store';
import { JsonFileStore } from '../storage/json-file-store';
import { ACCOUNT_ADAPTERS, type AccountContext, envValue, pathFor } from './accounts/adapters';
import { ensureAccount, type ProvisionFs, removeAccountFolder } from './accounts/provisioner';
import { accountLogins, type AiDetectDeps, detectAiAgents } from './detect';

const AiAgentsFileSchema = z.object({
  version: z.literal(1),
  detectedAt: z.number().nullable().default(null),
  agents: z.array(DetectedAiAgentSchema).max(100).default([]),
  profiles: z.array(AiProfileSchema).max(100).default([]),
  hidden: z.array(z.string().max(200)).max(300).default([]),
  accounts: z.array(AgentAccountSchema).max(50).default([]),
  /** Who each added account is signed in with (detected from its folder). */
  logins: z.record(z.string(), z.array(AiAccountSchema).max(20)).default({}),
});
type AiAgentsFile = z.infer<typeof AiAgentsFileSchema>;

export interface AiAgentsServiceDeps {
  file: string;
  secrets: SecretStore;
  detectDeps: () => AiDetectDeps;
  logger: Logger;
  now?: () => number;
  /** Added accounts: their folders live in `root` (`~/.oxytocin/accounts`). */
  accounts?: {
    root: string;
    fs: ProvisionFs;
    deleteKeychainEntry?: (service: string) => Promise<void>;
  };
}

/**
 * Settings → AI Agents: detected agent CLIs with their accounts, and profiles that run Claude Code against another
 * Anthropic-compatible API. Stored in `ai-agents.json`; profile API keys in the SecretStore.
 */
export class AiAgentsService implements Disposable {
  private readonly store: JsonFileStore<AiAgentsFile>;
  private readonly changeEmitter = new Emitter<AiAgentsState>();
  readonly onDidChange = this.changeEmitter.event;
  private detecting: Promise<AiAgentsState> | undefined;
  /** Per account: what could not be shared at its last start. */
  private readonly notes = new Map<string, string[]>();

  constructor(private readonly deps: AiAgentsServiceDeps) {
    this.store = new JsonFileStore({
      path: deps.file,
      schema: AiAgentsFileSchema,
      defaults: () => ({
        version: 1,
        detectedAt: null,
        agents: [],
        profiles: [],
        hidden: [],
        accounts: [],
        logins: {},
      }),
      debounceMs: 0,
      backup: true,
      logger: deps.logger,
    });
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  state(): AiAgentsState {
    const s = this.store.get();
    const secrets = this.deps.secrets.status(AI_PROFILE_SECRET_SCOPE);
    return {
      detectedAt: s.detectedAt,
      agents: s.agents,
      profiles: s.profiles,
      hidden: s.hidden,
      keys: secrets.stored.filter((k) => k.endsWith('/apiKey')).map((k) => k.slice(0, -'/apiKey'.length)),
      encrypted: secrets.encrypted,
      accounts: s.accounts,
      accountsInfo: this.accountsInfo(s),
    };
  }

  private context(): AccountContext {
    const d = this.deps.detectDeps();
    return { platform: d.platform, env: d.env, home: d.home };
  }

  private accountsInfo(s: AiAgentsFile): AiAgentsState['accountsInfo'] {
    const ctx = this.context();
    const mainHomes: Record<string, string> = {};
    for (const agent of AI_ACCOUNT_AGENTS) mainHomes[agent] = ACCOUNT_ADAPTERS[agent].mainHome(ctx);
    const ids = new Set(s.accounts.map((a) => a.id));
    return {
      mainHomes,
      overridden: Object.values(AI_ACCOUNT_HOME_VARIABLES).filter((v) => envValue(ctx, v) !== undefined),
      logins: Object.fromEntries(Object.entries(s.logins).filter(([id]) => ids.has(id))),
      notes: Object.fromEntries([...this.notes].filter(([id, n]) => ids.has(id) && n.length > 0)),
    };
  }

  private provisionDeps() {
    const accounts = this.deps.accounts;
    if (!accounts) throw new OxyError('UNAVAILABLE', 'Accounts are not available.');
    return {
      ...this.context(),
      fs: accounts.fs,
      accountsRoot: accounts.root,
      ...(accounts.deleteKeychainEntry ? { deleteKeychainEntry: accounts.deleteKeychainEntry } : {}),
    };
  }

  private fire(): AiAgentsState {
    const state = this.state();
    this.changeEmitter.fire(state);
    return state;
  }

  /** Reads again who the added accounts are signed in with (cheap: a few files); fires when it changed. */
  async refreshAccounts(): Promise<AiAgentsState> {
    return (await this.updateLogins()) ? this.fire() : this.state();
  }

  private async updateLogins(): Promise<boolean> {
    const deps = this.deps.detectDeps();
    const logins = Object.fromEntries(
      await Promise.all(
        this.store
          .get()
          .accounts.map(async (a) => [a.id, await accountLogins(deps, a.agent, a.home).catch(() => [])] as const),
      ),
    );
    if (JSON.stringify(logins) === JSON.stringify(this.store.get().logins)) return false;
    this.store.update((x) => ({ ...x, logins }));
    await this.store.flush();
    return true;
  }

  /**
   * Adds an account: a new folder in `~/.oxytocin/accounts/<agent>/<name>`, set up to share the main account's
   * setup (or nothing), without a sign-in. Its first terminal signs in.
   */
  async addAccount(o: { agent: AiAccountAgent; name: string; mode: AgentAccountMode }): Promise<AiAgentsState> {
    const deps = this.provisionDeps();
    const s = this.store.get();
    if (s.accounts.length >= 50) throw new OxyError('INVALID', 'Too many accounts.');
    const problem = validateAccountName(o.name, o.agent, s.accounts);
    if (problem) throw new OxyError('INVALID', problem);
    const p = pathFor(deps.platform);
    const folder = p.join(p.resolve(deps.accountsRoot), o.agent);
    // The folder name is chosen once (a Keychain entry depends on it): never one already on disk.
    const taken = s.accounts.filter((a) => a.agent === o.agent).map((a) => p.basename(a.home));
    let slug = accountSlug(o.name, taken);
    while ((await deps.fs.kind(p.join(folder, slug))) !== 'missing') slug = accountSlug(o.name, [...taken, slug]);
    const account = AgentAccountSchema.parse({
      id: `acc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      agent: o.agent,
      name: o.name.trim(),
      home: p.join(folder, slug),
      mode: o.mode,
      createdAt: (this.deps.now ?? Date.now)(),
    });
    this.notes.set(account.id, await ensureAccount(account, deps));
    this.store.update((x) => ({ ...x, accounts: [...x.accounts, account] }));
    await this.store.flush();
    this.deps.logger.info(`Account added: ${account.agent} ${account.home} (${account.mode})`);
    return this.fire();
  }

  /** Removes an account and deletes its folder (its sign-in, sessions and history). */
  async removeAccount(id: string): Promise<AiAgentsState> {
    const account = this.store.get().accounts.find((a) => a.id === id);
    if (!account) throw new OxyError('NOT_FOUND', 'No such account.');
    await removeAccountFolder(account, this.provisionDeps());
    const launchId = aiAccountLaunchId(id);
    this.store.update((x) => {
      const { [id]: _removed, ...logins } = x.logins;
      return {
        ...x,
        accounts: x.accounts.filter((a) => a.id !== id),
        hidden: x.hidden.filter((h) => h !== launchId),
        logins,
      };
    });
    this.notes.delete(id);
    await this.store.flush();
    this.deps.logger.info(`Account removed: ${account.agent} ${account.home}`);
    return this.fire();
  }

  /** The added accounts' folders of an agent (e.g. for the Claude Code session registry). */
  accountHomes(agent: AiAccountAgent): string[] {
    return this.store
      .get()
      .accounts.filter((a) => a.agent === agent)
      .map((a) => a.home);
  }

  /**
   * The terminal profile behind an `ai:` launch id, prepared to start: an added account's folder is set up again
   * first (links repaired, the main account's settings copied where Windows refused a link).
   */
  async prepareLaunch(launchId: string): Promise<TerminalProfile | undefined> {
    if (launchId.startsWith(ACCOUNT_LAUNCH_PREFIX) && this.deps.accounts) {
      const account = this.store.get().accounts.find((a) => a.id === launchId.slice(ACCOUNT_LAUNCH_PREFIX.length));
      if (account) {
        const notes = await ensureAccount(account, this.provisionDeps()).catch((e: unknown) => {
          this.deps.logger.warn(`Account folder ${account.home} could not be set up`, e);
          return [`The account folder could not be set up: ${e instanceof Error ? e.message : String(e)}`];
        });
        const before = JSON.stringify(this.notes.get(account.id) ?? []);
        this.notes.set(account.id, notes);
        if (JSON.stringify(notes) !== before) this.fire();
      }
    }
    return this.launchProfile(launchId);
  }

  /** Looks for the agents again (one detection at a time). */
  detect(): Promise<AiAgentsState> {
    this.detecting ??= (async () => {
      try {
        const agents = await detectAiAgents(this.deps.detectDeps());
        this.store.update((s) => ({ ...s, agents, detectedAt: (this.deps.now ?? Date.now)() }));
        await this.store.flush();
        this.deps.logger.info(`AI agents detected: ${agents.map((a) => a.id).join(', ') || 'none'}`);
        await this.updateLogins();
        return this.fire();
      } finally {
        this.detecting = undefined;
      }
    })();
    return this.detecting;
  }

  async save(o: { profiles: unknown; hidden: string[]; secrets: SecretChange[] }): Promise<AiAgentsState> {
    const parsed = z.array(AiProfileSchema).max(100).safeParse(o.profiles);
    if (!parsed.success) throw new OxyError('INVALID', `Invalid profiles: ${parsed.error.issues[0]?.message ?? ''}`);
    const profiles = parsed.data.map((p) => ({ ...p, name: p.name.trim(), baseUrl: p.baseUrl.trim() }));
    const problems = validateProfiles(profiles);
    if (problems.length) throw new OxyError('INVALID', problems.join(' '));
    const ids = new Set(profiles.map((p) => p.id));
    for (const change of o.secrets) {
      if (!ids.has(change.resourceId)) throw new OxyError('INVALID', `No profile ${change.resourceId}.`);
      if (change.key !== 'apiKey') throw new OxyError('INVALID', 'A profile only has an API key.');
      if (change.value === null) await this.deps.secrets.delete(AI_PROFILE_SECRET_SCOPE, change.resourceId, 'apiKey');
      else await this.deps.secrets.set(AI_PROFILE_SECRET_SCOPE, change.resourceId, 'apiKey', change.value);
    }
    await this.deps.secrets.retain(AI_PROFILE_SECRET_SCOPE, ids);
    this.store.update((s) => ({ ...s, profiles, hidden: [...new Set(o.hidden)].slice(0, 300) }));
    await this.store.flush();
    const state = this.state();
    this.changeEmitter.fire(state);
    return state;
  }

  /**
   * The terminal profile behind an `ai:` launch id: a detected agent (`ai:claude`), a profile (`ai:profile:<id>`,
   * with its API key in the environment — main only, never sent to the renderer) or an added account
   * (`ai:account:<id>`, with its folder in CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME).
   */
  launchProfile(launchId: string): TerminalProfile | undefined {
    const s = this.store.get();
    if (launchId.startsWith(ACCOUNT_LAUNCH_PREFIX)) {
      const account = s.accounts.find((a) => a.id === launchId.slice(ACCOUNT_LAUNCH_PREFIX.length));
      return account ? this.forAccount(launchId, account) : undefined;
    }
    if (launchId.startsWith('ai:profile:')) {
      const profile = s.profiles.find((p) => p.id === launchId.slice('ai:profile:'.length));
      if (!profile) return undefined;
      return this.forProfile(launchId, profile);
    }
    const id = launchId.slice('ai:'.length);
    const agent = s.agents.find((a) => a.id === id && a.category === 'agent');
    // An agent not detected (yet) still starts by its command, e.g. a terminal restored after a restart.
    const known = AI_AGENT_CATALOG.find((k) => k.id === id && k.category === 'agent');
    const name = agent?.name ?? known?.name;
    const command = agent?.command ?? known?.command;
    if (!name || !command) return undefined;
    return {
      id: launchId,
      name,
      kind: 'agent',
      file: '',
      args: [],
      source: 'builtin-agent',
      command,
      icon: `agent-${id}`,
    };
  }

  private forAccount(launchId: string, account: AgentAccount): TerminalProfile {
    const kind = AI_AGENT_CATALOG.find((k) => k.id === account.agent);
    const detected = this.store.get().agents.find((a) => a.id === account.agent);
    const name = kind?.name ?? account.agent;
    return {
      id: launchId,
      name: `${name} · ${account.name}`,
      kind: 'agent',
      file: '',
      args: [],
      source: 'builtin-agent',
      command: detected?.command ?? kind?.command ?? account.agent,
      icon: `agent-${account.agent}`,
      env: accountEnv(account),
    };
  }

  private forProfile(launchId: string, profile: AiProfile): TerminalProfile {
    const key = this.deps.secrets.getAll(AI_PROFILE_SECRET_SCOPE, profile.id)['apiKey'];
    return {
      id: launchId,
      name: profile.name,
      kind: 'agent',
      file: '',
      args: [],
      source: 'builtin-agent',
      command: 'claude',
      icon: 'agent-claude',
      env: profileEnv(profile, key),
    };
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
