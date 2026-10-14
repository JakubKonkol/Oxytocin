import { describe, expect, it } from 'vitest';
import {
  type AiAgentsState,
  AiProfileSchema,
  newProfile,
  profileEnv,
  validateProfiles,
} from '@shared/domain/ai-agents';
import { agoText, menuEntries, profileSecretChanges, withHidden } from './ai-agents-model';

const state = (over: Partial<AiAgentsState> = {}): AiAgentsState => ({
  detectedAt: 1,
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      category: 'agent',
      accounts: [{ label: 'me@firma.pl', method: 'oauth' }],
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      command: 'codex',
      category: 'agent',
      accounts: [
        { label: 'codex@firma.pl', method: 'oauth' },
        { label: 'OPENAI_API_KEY', method: 'api-key' },
      ],
    },
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', category: 'agent', accounts: [] },
    { id: 'ollama', name: 'Ollama', command: 'ollama', category: 'runtime', accounts: [], models: ['qwen3'] },
  ],
  profiles: [AiProfileSchema.parse({ id: 'p1', name: 'Claude Code · GLM', provider: 'glm', baseUrl: 'https://x' })],
  hidden: ['ai:gemini'],
  keys: [],
  encrypted: true,
  ...over,
});

describe('AI agents model', () => {
  it('lists the + menu entries: agents with their account, then profiles, minus hidden ones', () => {
    expect(menuEntries(null)).toEqual([]);
    expect(menuEntries(state())).toEqual([
      { launchId: 'ai:claude', name: 'Claude Code', detail: 'me@firma.pl', kind: 'agent' },
      { launchId: 'ai:codex', name: 'Codex CLI', detail: 'codex@firma.pl +1', kind: 'agent' },
      { launchId: 'ai:profile:p1', name: 'Claude Code · GLM', detail: 'GLM (Z.ai)', kind: 'profile' },
    ]);
    expect(menuEntries(state({ hidden: ['ai:profile:p1', 'ai:claude', 'ai:codex'] })).map((e) => e.launchId)).toEqual([
      'ai:gemini',
    ]);
  });

  it('toggles hidden entries and collects key changes of existing profiles', () => {
    expect(withHidden(['ai:a'], 'ai:b', false)).toEqual(['ai:a', 'ai:b']);
    expect(withHidden(['ai:a', 'ai:b'], 'ai:a', true)).toEqual(['ai:b']);
    const profiles = state().profiles;
    expect(profileSecretChanges(profiles, { p1: { value: 'k' }, gone: { value: 'x' }, p2: { remove: true } })).toEqual([
      { resourceId: 'p1', key: 'apiKey', value: 'k' },
    ]);
    expect(profileSecretChanges(profiles, { p1: { remove: true } })).toEqual([
      { resourceId: 'p1', key: 'apiKey', value: null },
    ]);
  });

  it('builds profiles from presets and their environment', () => {
    const a = newProfile([], 'openrouter');
    expect(a).toMatchObject({
      name: 'Claude Code · OpenRouter',
      baseUrl: 'https://openrouter.ai/api',
      agent: 'claude',
    });
    expect(newProfile([a], 'openrouter').name).toBe('Claude Code · OpenRouter 2');
    expect(newProfile([], 'ollama', 'qwen3')).toMatchObject({ name: 'Claude Code · Ollama', model: 'qwen3' });
    expect(validateProfiles([a, { ...a, id: 'x' }])).toEqual(['Two profiles are named "Claude Code · OpenRouter".']);
    expect(validateProfiles([{ ...a, baseUrl: 'https://u:p@x.io' }])[0]).toMatch(/without credentials/);
    expect(profileEnv({ ...a, model: 'm', fastModel: 'f' }, 'key')).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'key',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'm',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'm',
      CLAUDE_CODE_SUBAGENT_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'f',
      ANTHROPIC_SMALL_FAST_MODEL: 'f',
    });
    // No model: the provider maps Claude's model names itself.
    expect(Object.keys(profileEnv(a, undefined))).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('formats how long ago detection ran', () => {
    expect(agoText(null)).toBe('never');
    expect(agoText(1000, 2000)).toBe('just now');
    expect(agoText(0, 5 * 60_000)).toBe('5 minutes ago');
    expect(agoText(0, 3 * 3600_000)).toBe('3 hours ago');
  });
});
