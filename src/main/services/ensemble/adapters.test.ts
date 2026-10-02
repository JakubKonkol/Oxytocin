import { describe, expect, it } from 'vitest';
import type { EnsembleAgent } from '@shared/domain/ensemble';
import { agentFromPreset } from '@shared/ensemble/presets';
import { buildLaunch, type LaunchContext, sessionName } from './adapters';

const ctx: LaunchContext = {
  command: 'claude',
  promptFile: '/data/ada.prompt.md',
  configFile: '/data/ada.mcp.json',
  mcpUrl: 'http://127.0.0.1:47287/mcp/ensemble',
  token: 'tok-123',
  sessionId: 'sess-1',
  sessionName: 'ens:CSV export/Ada',
};

const agent = (patch: Partial<EnsembleAgent> = {}): EnsembleAgent => ({
  ...agentFromPreset('planner', []),
  ...patch,
});

describe('agent adapters', () => {
  it('Claude Code: model, effort, prompt file and its own MCP server per session; read-only agents cannot edit', () => {
    const spec = buildLaunch(agent(), ctx);
    expect(spec.args).toEqual([
      '--session-id',
      'sess-1',
      '--name',
      'ens:CSV export/Ada',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'xhigh',
      '--append-system-prompt-file',
      '/data/ada.prompt.md',
      '--mcp-config',
      '/data/ada.mcp.json',
      '--allowedTools',
      'mcp__oxytocin-ensemble',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
    ]);
    expect(JSON.parse(spec.files[0]!.content)).toEqual({
      mcpServers: {
        'oxytocin-ensemble': {
          type: 'http',
          url: ctx.mcpUrl,
          headers: { Authorization: 'Bearer tok-123' },
        },
      },
    });
    expect(spec.files[0]!.secret).toBe(true);
    expect(spec.cliSessionId).toBe('sess-1');
  });

  it('Claude Code: a resumed session keeps its id; an API researcher may read web pages without asking', () => {
    const resumed = buildLaunch(agent({ permissionMode: 'acceptEdits', readOnly: false }), {
      ...ctx,
      resumeSessionId: 'old',
    });
    expect(resumed.args.slice(0, 2)).toEqual(['--resume', 'old']);
    expect(resumed.args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(resumed.cliSessionId).toBe('old');
    const api = buildLaunch(agentFromPreset('api-researcher', []), ctx);
    const i = api.args.indexOf('--allowedTools');
    expect(api.args.slice(i, i + 3)).toEqual(['--allowedTools', 'mcp__oxytocin-ensemble', 'WebFetch']);
  });

  it('Codex CLI, Gemini CLI and OpenCode get the Ensemble server without touching the user configuration', () => {
    const codex = buildLaunch(agent({ cli: 'codex', model: 'gpt-5.5', effort: 'high' }), { ...ctx, command: 'codex' });
    expect(codex.args).toEqual(
      expect.arrayContaining([
        '-m',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort=high',
        '-c',
        'mcp_servers.oxytocin_ensemble.bearer_token_env_var=OXYTOCIN_ENSEMBLE_TOKEN',
        '-s',
        'read-only',
      ]),
    );
    expect(codex.env['OXYTOCIN_ENSEMBLE_TOKEN']).toBe('tok-123');

    const gemini = buildLaunch(agent({ cli: 'gemini-cli', model: 'gemini-2.5-pro', effort: '' }), ctx);
    expect(gemini.args).toEqual(expect.arrayContaining(['--skip-trust', '--approval-mode', 'plan']));
    expect(gemini.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBe(ctx.configFile);

    const opencode = buildLaunch(agent({ cli: 'opencode', model: 'anthropic/claude-sonnet-5-5' }), ctx);
    expect(opencode.args).toEqual(['-m', 'anthropic/claude-sonnet-5-5', '--agent', 'plan']);
    expect(JSON.parse(opencode.env['OPENCODE_CONFIG_CONTENT']!)).toMatchObject({
      mcp: { 'oxytocin-ensemble': { url: ctx.mcpUrl, headers: { Authorization: 'Bearer tok-123' } } },
    });
  });

  it('session names only keep characters every shell accepts', () => {
    expect(sessionName('CSV: export "now"!', 'Ada')).toBe('ens:CSV export now/Ada');
  });
});
