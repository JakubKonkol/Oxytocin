import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/domain/settings';
import type { Logger } from '@shared/logging/logger';
import { SecretStore, type SafeStorageLike } from '../secrets/secret-store';
import { ProfileService } from '../terminals/profiles';
import { AiAgentsService } from './ai-agents-service';
import type { AiDetectDeps } from './detect';

const logger: Logger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };
const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`x${s}`),
  decryptString: (b) => b.toString().slice(1),
};

const detectDeps = (): AiDetectDeps => ({
  platform: 'linux',
  env: {},
  home: '/home/u',
  which: (name) => Promise.resolve(name === 'claude' || name === 'codex' ? `/usr/bin/${name}` : null),
  readText: (p) =>
    Promise.resolve(
      p === '/home/u/.claude.json' ? JSON.stringify({ oauthAccount: { emailAddress: 'me@firma.pl' } }) : null,
    ),
  exists: () => Promise.resolve(false),
  run: () => Promise.resolve('1.0.0'),
  httpJson: () => Promise.resolve(null),
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-ai-'));
  const secrets = new SecretStore(join(dir, 'secrets.json'), safe, logger);
  await secrets.load();
  const service = new AiAgentsService({
    file: join(dir, 'ai-agents.json'),
    secrets,
    detectDeps,
    logger,
    now: () => 1000,
  });
  await service.load();
  return { dir, secrets, service };
}

describe('AiAgentsService', () => {
  it('detects agents, stores the result and starts them by their command', async () => {
    const { service, dir, secrets } = await setup();
    expect(service.state()).toMatchObject({ detectedAt: null, agents: [] });
    const events: number[] = [];
    service.onDidChange((s) => events.push(s.agents.length));
    const state = await service.detect();
    expect(state.detectedAt).toBe(1000);
    expect(state.agents.map((a) => a.id)).toEqual(['claude', 'codex']);
    expect(state.agents[0]!.accounts[0]!.label).toBe('me@firma.pl');
    expect(events).toEqual([2]);
    // Persisted.
    const again = new AiAgentsService({ file: join(dir, 'ai-agents.json'), secrets, detectDeps, logger });
    await again.load();
    expect(again.state().agents).toHaveLength(2);
    expect(service.launchProfile('ai:claude')).toMatchObject({ kind: 'agent', command: 'claude', name: 'Claude Code' });
    // Known agents start by their command even before a detection (a restored terminal).
    expect(service.launchProfile('ai:gemini')).toMatchObject({ command: 'gemini' });
    expect(service.launchProfile('ai:ollama')).toBeUndefined();
    expect(service.launchProfile('ai:nope')).toBeUndefined();
  });

  it('saves profiles with write-only API keys and runs Claude Code against their API', async () => {
    const { service, secrets } = await setup();
    const glm = { id: 'p1', name: 'Claude Code · GLM', provider: 'glm', baseUrl: 'https://api.z.ai/api/anthropic/' };
    await expect(service.save({ profiles: [{ ...glm, baseUrl: 'ftp://x' }], hidden: [], secrets: [] })).rejects.toThrow(
      /base URL/,
    );
    const state = await service.save({
      profiles: [
        glm,
        { id: 'p2', name: 'Local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3' },
      ],
      hidden: ['ai:codex', 'ai:codex'],
      secrets: [{ resourceId: 'p1', key: 'apiKey', value: 'zai-key' }],
    });
    expect(state).toMatchObject({ keys: ['p1'], hidden: ['ai:codex'] });
    expect(JSON.stringify(state)).not.toContain('zai-key');
    expect(service.launchProfile('ai:profile:p1')).toMatchObject({
      name: 'Claude Code · GLM',
      command: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'zai-key',
        ANTHROPIC_API_KEY: '',
      },
    });
    expect(service.launchProfile('ai:profile:p2')?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      ANTHROPIC_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3',
    });
    // Removing a profile removes its key.
    await service.save({ profiles: [], hidden: [], secrets: [] });
    expect(secrets.status('ai-profiles').stored).toEqual([]);
    expect(service.launchProfile('ai:profile:p1')).toBeUndefined();
  });

  it('the terminal profiles resolve ai: ids through the service', async () => {
    const { service } = await setup();
    await service.save({
      profiles: [{ id: 'p1', name: 'Kimi', provider: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic' }],
      hidden: [],
      secrets: [{ resourceId: 'p1', key: 'apiKey', value: 'k' }],
    });
    const profiles = new ProfileService(
      {
        platform: 'linux',
        env: { PATH: '/bin', SHELL: '/bin/bash' },
        isFile: (p) => Promise.resolve(p === '/bin/bash'),
        readText: () => Promise.resolve('/bin/bash\n'),
        exec: () => Promise.resolve(null),
      },
      () => defaultSettings('linux'),
      Date.now,
      () => [],
      (id) => service.launchProfile(id),
    );
    const launch = await profiles.resolveLaunch('ai:profile:p1', '/tmp');
    expect(launch).toMatchObject({
      file: '/bin/bash',
      initialCommand: 'claude',
      profile: { id: 'ai:profile:p1', name: 'Kimi' },
    });
    expect(launch.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'k',
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
    });
    // ai: profiles are not listed with the terminal profiles.
    expect((await profiles.list()).some((p) => p.id.startsWith('ai:'))).toBe(false);
    await expect(profiles.resolveLaunch('ai:profile:gone', '/tmp')).rejects.toThrow(/not found/);
  });
});
