import { describe, expect, it } from 'vitest';
import { accountLogins, type AiDetectDeps, detectAiAgents, ghUsers, jwtClaims, versionLine } from './detect';

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

function deps(o: {
  bins: Record<string, string>;
  files?: Record<string, string>;
  env?: Record<string, string>;
  http?: Record<string, unknown>;
  run?: Record<string, string>;
}): AiDetectDeps {
  const files = o.files ?? {};
  return {
    platform: 'linux',
    env: o.env ?? {},
    home: '/home/u',
    which: (name) => Promise.resolve(o.bins[name] ?? null),
    readText: (p) => Promise.resolve(files[p] ?? null),
    exists: (p) => Promise.resolve(Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`))),
    run: (line) => Promise.resolve(Object.entries(o.run ?? {}).find(([k]) => line.endsWith(k))?.[1] ?? null),
    httpJson: (url) => Promise.resolve(o.http?.[url] ?? null),
  };
}

describe('AI agent detection', () => {
  it('finds the agents on PATH with their versions and accounts, never their tokens', async () => {
    const found = await detectAiAgents(
      deps({
        bins: {
          claude: '/usr/bin/claude',
          codex: '/usr/bin/codex',
          gemini: '/usr/bin/gemini',
          copilot: '/usr/bin/copilot',
          opencode: '/usr/bin/opencode',
          aider: '/usr/bin/aider',
        },
        files: {
          '/home/u/.claude.json': JSON.stringify({
            oauthAccount: { emailAddress: 'me@firma.pl', organizationName: 'Firma' },
          }),
          '/home/u/.claude/.credentials.json': JSON.stringify({
            claudeAiOauth: { accessToken: 'SECRET', subscriptionType: 'max' },
          }),
          '/home/u/.codex/auth.json': JSON.stringify({
            tokens: {
              id_token: jwt({ email: 'codex@firma.pl', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
              access_token: 'SECRET',
            },
          }),
          '/home/u/.gemini/google_accounts.json': JSON.stringify({ active: 'g@gmail.com', old: [] }),
          '/home/u/.copilot/config.json': JSON.stringify({
            last_logged_in_user: { host: 'https://github.com', login: 'octo' },
            logged_in_users: [
              { host: 'https://github.com', login: 'octo' },
              { host: 'https://ghe.firma.pl', login: 'jk' },
            ],
          }),
          '/home/u/.local/share/opencode/auth.json': JSON.stringify({
            anthropic: { type: 'oauth', refresh: 'SECRET' },
            openrouter: { type: 'api', key: 'SECRET' },
          }),
        },
        env: { OPENROUTER_API_KEY: 'SECRET' },
        run: { '--version': '2.3.4 (Claude Code)\n' },
      }),
    );
    expect(JSON.stringify(found)).not.toContain('SECRET');
    const by = Object.fromEntries(found.map((a) => [a.id, a]));
    expect(Object.keys(by)).toEqual(['claude', 'codex', 'gemini', 'copilot', 'opencode', 'aider']);
    expect(by['claude']).toMatchObject({
      name: 'Claude Code',
      path: '/usr/bin/claude',
      version: '2.3.4 (Claude Code)',
      accounts: [{ label: 'me@firma.pl', method: 'oauth', plan: 'Max', detail: 'Organization: Firma' }],
    });
    expect(by['codex']!.accounts).toEqual([{ label: 'codex@firma.pl', method: 'oauth', plan: 'Plus' }]);
    expect(by['gemini']!.accounts).toEqual([{ label: 'g@gmail.com', method: 'oauth' }]);
    expect(by['copilot']!.accounts.map((a) => a.label)).toEqual(['octo', 'jk']);
    expect(by['opencode']!.accounts.map((a) => `${a.label}:${a.method}`)).toEqual([
      'anthropic:oauth',
      'openrouter:api-key',
    ]);
    expect(by['aider']!.accounts).toEqual([
      { label: 'OPENROUTER_API_KEY', method: 'api-key', detail: 'From the environment' },
    ]);
  });

  it('reports API keys, the legacy gh copilot extension and local runtimes', async () => {
    const found = await detectAiAgents(
      deps({
        bins: { claude: '/usr/bin/claude', codex: '/usr/bin/codex', gh: '/usr/bin/gh', ollama: '/usr/bin/ollama' },
        files: {
          '/home/u/.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: 'SECRET', tokens: null }),
          '/home/u/.local/share/gh/extensions/gh-copilot/manifest.yml': 'name: gh-copilot',
          '/home/u/.config/gh/hosts.yml': 'github.com:\n    oauth_token: SECRET\n    user: octo\n',
        },
        env: { ANTHROPIC_API_KEY: 'SECRET' },
        http: {
          'http://127.0.0.1:11434/api/tags': { models: [{ name: 'qwen3-coder:30b' }, { name: 'gpt-oss:20b' }] },
          // Something else on port 8080 is not llama.cpp.
          'http://127.0.0.1:8080/props': { hello: 'world' },
        },
      }),
    );
    expect(JSON.stringify(found)).not.toContain('SECRET');
    const by = Object.fromEntries(found.map((a) => [a.id, a]));
    expect(by['claude']!.accounts).toEqual([
      { label: 'ANTHROPIC_API_KEY', method: 'api-key', detail: 'From the environment' },
    ]);
    expect(by['codex']!.accounts).toEqual([{ label: 'API key', method: 'api-key', detail: 'Codex auth.json' }]);
    expect(by['gh-copilot']).toMatchObject({ legacy: true, accounts: [{ label: 'octo' }] });
    expect(by['ollama']).toMatchObject({
      category: 'runtime',
      running: true,
      models: ['qwen3-coder:30b', 'gpt-oss:20b'],
      url: 'http://127.0.0.1:11434',
    });
    expect(by['llamacpp']).toBeUndefined();
  });

  it('finds a running llama.cpp server without the binary on PATH', async () => {
    const found = await detectAiAgents(
      deps({
        bins: {},
        http: {
          'http://127.0.0.1:8080/props': { default_generation_settings: {} },
          'http://127.0.0.1:8080/v1/models': { object: 'list', data: [{ id: 'gemma-3-12b' }] },
        },
      }),
    );
    expect(found).toEqual([expect.objectContaining({ id: 'llamacpp', running: true, models: ['gemma-3-12b'] })]);
  });

  it('parses helpers', () => {
    expect(jwtClaims(jwt({ email: 'a@b.c' }))).toEqual({ email: 'a@b.c' });
    expect(jwtClaims('garbage')).toBeNull();
    expect(versionLine('\n  codex-cli 0.50.0\n')).toBe('codex-cli 0.50.0');
    expect(versionLine(null)).toBeUndefined();
    expect(ghUsers('github.com:\n    user: a\nghe.example.com:\n    user: b\n')).toEqual([
      { label: 'a', method: 'oauth' },
      { label: 'b', method: 'oauth', detail: 'ghe.example.com' },
    ]);
  });

  it('reads the sign-in of an added account from its own folder, not from the environment', async () => {
    const acc = '/home/u/.oxytocin/accounts';
    const d = deps({
      bins: {},
      env: { ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y' },
      files: {
        [`${acc}/claude/work/.claude.json`]: JSON.stringify({ oauthAccount: { emailAddress: 'praca@firma.pl' } }),
        [`${acc}/claude/work/.credentials.json`]: JSON.stringify({ claudeAiOauth: { subscriptionType: 'team' } }),
        [`${acc}/codex/work/auth.json`]: JSON.stringify({ tokens: { id_token: jwt({ email: 'dev@firma.pl' }) } }),
        [`${acc}/gemini/work/.gemini/google_accounts.json`]: JSON.stringify({ active: 'g@firma.pl' }),
      },
    });
    expect(await accountLogins(d, 'claude', `${acc}/claude/work`)).toEqual([
      { label: 'praca@firma.pl', method: 'oauth', plan: 'Team' },
    ]);
    expect(await accountLogins(d, 'codex', `${acc}/codex/work`)).toEqual([{ label: 'dev@firma.pl', method: 'oauth' }]);
    expect(await accountLogins(d, 'gemini', `${acc}/gemini/work`)).toEqual([{ label: 'g@firma.pl', method: 'oauth' }]);
    expect(await accountLogins(d, 'claude', `${acc}/claude/new`)).toEqual([]);
  });

  it('finds the Gemini CLI account in GEMINI_CLI_HOME', async () => {
    const found = await detectAiAgents(
      deps({
        bins: { gemini: '/usr/bin/gemini' },
        env: { GEMINI_CLI_HOME: '/data/g' },
        files: { '/data/g/.gemini/google_accounts.json': JSON.stringify({ active: 'me@gmail.com' }) },
      }),
    );
    expect(found[0]?.accounts).toEqual([{ label: 'me@gmail.com', method: 'oauth' }]);
  });
});
