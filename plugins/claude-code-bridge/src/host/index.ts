import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { PluginContext } from '@oxytocin/plugin-api';
import { createCliRunner, installInClaude, isInstalledInClaude, refreshInClaude, removeFromClaude } from './claude-cli';
import { TOKEN_VAR, writeMarketplace } from './claude-plugin';
import { BriefedSessions, briefOutput, stateFromHook } from './events';
import { BridgeServer } from './server';
import type { ActionResult, BridgeStatus } from '../shared/status';

export const PANEL_TYPE = 'claudeBridge.setup';
const DEFAULT_PORT = 47285;
const RETRY_MS = 30_000;

/**
 * Claude Code Bridge (M9-T5): Claude Code `http` hooks → a local endpoint → agent states with the `hook` source.
 * Terminals get a secret token (`OXYTOCIN_BRIDGE_TOKEN`); the hooks send it with the terminal id, so events are
 * attributed to the exact terminal. The hooks are installed into Claude Code only when the user asks (setup panel).
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  let token = ctx.storage.get<string>('token');
  if (!token) {
    token = randomBytes(32).toString('hex');
    await ctx.storage.set('token', token);
  }
  // Every terminal: Claude Code can be started in any of them.
  const env = oxy.terminals.environment;
  env.description = 'Claude Code Bridge';
  env.replace(TOKEN_VAR, token);
  env.ready();

  const port = () => oxy.settings.get<number>('claudeBridge.port') || DEFAULT_PORT;
  const claudeCommand = () => oxy.settings.get<string>('claudeBridge.claudeCommand') || 'claude';
  const marketplaceDir = join(ctx.storage.globalDir, 'claude-marketplace');
  const run = createCliRunner(claudeCommand);
  let installed: boolean | null = ctx.storage.get<boolean>('installed') ?? null;

  // With a session's first prompt, Claude Code gets a brief about the project's databases and APIs (Oxytocin's
  // project resources), so it uses Oxytocin's tools instead of hunting for credentials.
  const briefed = new BriefedSessions();
  const server = new BridgeServer(token, async (terminalId, input) => {
    const report = stateFromHook(input);
    if (report) oxy.agents.reportState(terminalId, report);
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    if (input.hook_event_name === 'SessionEnd' && sessionId) briefed.forget(terminalId, sessionId);
    if (input.hook_event_name !== 'UserPromptSubmit' || !sessionId || !briefed.first(terminalId, sessionId)) return;
    const brief = await oxy.commands
      .execute<{ text: string } | null>('oxytocin.resources.agentBrief', { terminalId })
      .catch(() => null);
    return brief?.text ? briefOutput(brief.text) : undefined;
  });
  let retry: ReturnType<typeof setInterval> | undefined;
  const listen = async () => {
    try {
      await server.start(port());
      ctx.log.info(`Listening for Claude Code hooks on 127.0.0.1:${port()}`);
      clearInterval(retry);
      retry = undefined;
    } catch {
      ctx.log.warn(server.stats.error ?? 'Could not start the hook endpoint');
      retry ??= setInterval(() => void listen(), RETRY_MS);
    }
  };
  // Claude Code reads the local marketplace in place: rewriting it applies a new port to new sessions.
  const writeHooks = () =>
    writeMarketplace(marketplaceDir, port()).catch((e: unknown) =>
      ctx.log.error('Could not write the Claude Code plugin', e),
    );
  await writeHooks();
  await listen();

  let lastPort = port();
  const status = (): BridgeStatus => ({
    port: port(),
    listening: server.stats.port !== null,
    error: server.stats.error,
    events: server.stats.events,
    lastEventAt: server.stats.lastEventAt,
    installed,
    claudeCommand: claudeCommand(),
    marketplaceDir,
  });
  const remember = async (value: boolean | null) => {
    installed = value;
    if (value !== null) await ctx.storage.set('installed', value);
  };

  const hint = oxy.ui.statusBarItem('claudeBridge.hint');
  hint.text = '$(info) Claude Code hooks';
  hint.tooltip = 'Get exact Claude Code states in Oxytocin: set up the Claude Code Bridge';
  hint.command = 'claudeBridge.setup';

  ctx.subscriptions.push(
    { dispose: () => clearInterval(retry) },
    { dispose: () => void server.stop() },
    oxy.settings.onDidChange('claudeBridge.', () => {
      if (port() === lastPort) return;
      lastPort = port();
      void writeHooks()
        .then(() => listen())
        .then(async () => {
          if (!installed) return;
          const refreshed = await refreshInClaude(run);
          ctx.log.info(`Hooks updated in Claude Code for port ${port()}: ${refreshed.output}`);
        });
    }),
    oxy.commands.register('claudeBridge.setup', async () => {
      hint.hide();
      await ctx.storage.set('setupSeen', true);
      await oxy.ui.openPanel(PANEL_TYPE);
    }),
    oxy.ui.registerPanelProvider(PANEL_TYPE, {
      resolve(view) {
        view.title = 'Claude Code Bridge';
        view.onRequest('status', async () => {
          const listed = await isInstalledInClaude(run);
          if (listed !== null) await remember(listed);
          return status();
        });
        view.onRequest('install', async (): Promise<ActionResult> => {
          await writeHooks();
          const result = await installInClaude(run, marketplaceDir);
          if (result.ok) await remember(true);
          ctx.log.info(`Install in Claude Code: ${result.ok ? 'ok' : 'failed'} — ${result.output}`);
          return { ...result, status: status() };
        });
        view.onRequest('uninstall', async (): Promise<ActionResult> => {
          const result = await removeFromClaude(run);
          if (result.ok) await remember(false);
          ctx.log.info(`Remove from Claude Code: ${result.ok ? 'ok' : 'failed'} — ${result.output}`);
          return { ...result, status: status() };
        });
      },
    }),
    hint,
    // Discoverability: while Claude Code runs without the bridge, a status bar entry offers the setup (until the
    // panel has been opened once).
    oxy.agents.onDidChange((agents) => {
      const show =
        !installed && !ctx.storage.get<boolean>('setupSeen') && agents.some((a) => a.agentId === 'claude-code');
      if (show) hint.show();
      else hint.hide();
    }),
  );
}

export function deactivate(): void {
  // Subscriptions stop the endpoint.
}
