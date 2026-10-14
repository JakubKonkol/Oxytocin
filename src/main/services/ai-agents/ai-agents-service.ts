import { z } from 'zod';
import {
  AI_AGENT_CATALOG,
  AI_PROFILE_SECRET_SCOPE,
  type AiAgentsState,
  type AiProfile,
  AiProfileSchema,
  DetectedAiAgentSchema,
  profileEnv,
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
import { type AiDetectDeps, detectAiAgents } from './detect';

const AiAgentsFileSchema = z.object({
  version: z.literal(1),
  detectedAt: z.number().nullable().default(null),
  agents: z.array(DetectedAiAgentSchema).max(100).default([]),
  profiles: z.array(AiProfileSchema).max(100).default([]),
  hidden: z.array(z.string().max(200)).max(300).default([]),
});
type AiAgentsFile = z.infer<typeof AiAgentsFileSchema>;

export interface AiAgentsServiceDeps {
  file: string;
  secrets: SecretStore;
  detectDeps: () => AiDetectDeps;
  logger: Logger;
  now?: () => number;
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

  constructor(private readonly deps: AiAgentsServiceDeps) {
    this.store = new JsonFileStore({
      path: deps.file,
      schema: AiAgentsFileSchema,
      defaults: () => ({ version: 1, detectedAt: null, agents: [], profiles: [], hidden: [] }),
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
    };
  }

  /** Looks for the agents again (one detection at a time). */
  detect(): Promise<AiAgentsState> {
    this.detecting ??= (async () => {
      try {
        const agents = await detectAiAgents(this.deps.detectDeps());
        this.store.update((s) => ({ ...s, agents, detectedAt: (this.deps.now ?? Date.now)() }));
        await this.store.flush();
        this.deps.logger.info(`AI agents detected: ${agents.map((a) => a.id).join(', ') || 'none'}`);
        const state = this.state();
        this.changeEmitter.fire(state);
        return state;
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
   * The terminal profile behind an `ai:` launch id: a detected agent (`ai:claude`) or a profile
   * (`ai:profile:<id>`, with its API key in the environment — main only, never sent to the renderer).
   */
  launchProfile(launchId: string): TerminalProfile | undefined {
    const s = this.store.get();
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
