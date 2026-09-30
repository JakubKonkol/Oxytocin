import { Copy, KeyRound, Link2, Link2Off, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { McpCallLogEntry, McpPolicy, McpToolInfo } from '@shared/domain/mcp';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { useSettingsStore } from '../../stores/settings-store';
import { confirmDialog } from '../../stores/dialog-store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { StatusDot } from '../../ui/StatusDot';
import { notify } from '../../ui/Toast';
import { useMcpStore } from './mcp-store';

const POLICY_LABELS: Record<McpPolicy, string> = { allow: 'Run without asking', ask: 'Ask first', deny: 'Blocked' };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function update(patch: Record<string, unknown>): Promise<void> {
  try {
    await ipc.invoke('settings:update', patch);
  } catch (e) {
    notify('error', 'Could not save the setting', { description: errorText(e) });
  }
}

/** Turns a tool on or off (`mcp.tools.disabled`). */
export function toggleTool(disabled: readonly string[], name: string, enabled: boolean): string[] {
  const rest = disabled.filter((n) => n !== name);
  return enabled ? rest : [...rest, name];
}

/** Sets a tool's policy (`mcp.tools.policy`); the default policy is stored as "no entry". */
export function withPolicy(
  policies: Readonly<Record<string, McpPolicy>>,
  tool: Pick<McpToolInfo, 'name' | 'defaultPolicy'>,
  policy: McpPolicy,
): Record<string, McpPolicy> {
  const next = { ...policies };
  if (policy === tool.defaultPolicy) delete next[tool.name];
  else next[tool.name] = policy;
  return next;
}

/** Tools grouped by where they come from: Oxytocin first, then plugins. */
export function groupTools(tools: readonly McpToolInfo[]): { source: string; tools: McpToolInfo[] }[] {
  const groups = new Map<string, McpToolInfo[]>();
  for (const t of tools) {
    const source = t.source.kind === 'core' ? 'Oxytocin' : t.source.pluginName;
    groups.set(source, [...(groups.get(source) ?? []), t]);
  }
  return [...groups].map(([source, list]) => ({ source, tools: list }));
}

async function copy(text: string, what: string): Promise<void> {
  await ipc.invoke('clipboard:writeText', { text });
  notify('success', `${what} copied`, { description: 'It contains the access token of the local server.' });
}

function ServerStatus() {
  const status = useMcpStore((s) => s.state?.status);
  const [busy, setBusy] = useState<string | null>(null);
  if (!status) return null;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      notify('error', `${what} failed`, { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const running = status.port !== null;
  const connect = () =>
    run('Connecting Claude Code', async () => {
      const r = await ipc.invoke('mcp:connectClaude');
      if (!r.ok) {
        notify('error', 'Connecting Claude Code failed', { description: r.output });
        return;
      }
      notify('success', 'Claude Code is connected', {
        description: r.migrated
          ? 'The old "oxytocin-runner" server was removed: the Run tools are now part of "oxytocin". New Claude Code sessions use it.'
          : 'New Claude Code sessions can use Oxytocin\'s tools (MCP server "oxytocin").',
      });
    });
  return (
    <div data-testid="mcp-status" className="rounded-card border border-line-subtle bg-surface/60 p-3">
      <div className="flex items-center gap-2">
        <StatusDot state={status.error ? 'error' : running ? 'running' : 'idle'} />
        <span className="font-medium text-fg" data-testid="mcp-status-text">
          {status.error
            ? status.error
            : running
              ? `MCP server running at ${status.url}`
              : status.enabled
                ? 'MCP server starting…'
                : 'MCP server turned off'}
        </span>
      </div>
      {running && (
        <div className="mt-1 text-small text-fg-muted" data-testid="mcp-status-detail">
          {status.sessions} connected client{status.sessions === 1 ? '' : 's'} · {status.calls} tool call
          {status.calls === 1 ? '' : 's'} ·{' '}
          {status.claudeConnected === true
            ? 'connected to Claude Code'
            : status.claudeConnected === false
              ? 'not connected to Claude Code'
              : 'Claude Code: unknown'}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {status.claudeConnected === true ? (
          <Button
            size="sm"
            data-testid="mcp-disconnect"
            disabled={busy !== null}
            onClick={() =>
              void run('Disconnecting Claude Code', async () => {
                const r = await ipc.invoke('mcp:disconnectClaude');
                if (!r.ok) notify('error', 'Disconnecting Claude Code failed', { description: r.output });
              })
            }
          >
            <Link2Off size={12} /> Disconnect Claude Code
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            data-testid="mcp-connect"
            disabled={busy !== null || !running}
            onClick={() => void connect()}
          >
            <Link2 size={12} /> {busy === 'Connecting Claude Code' ? 'Connecting…' : 'Connect Claude Code'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-check"
          disabled={busy !== null}
          onClick={() => void run('Checking Claude Code', async () => void (await ipc.invoke('mcp:checkClaude')))}
        >
          <RefreshCw size={12} /> Check
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-copy-command"
          onClick={() =>
            void run('Copying', async () => copy((await ipc.invoke('mcp:clientConfig')).command, 'Command'))
          }
        >
          <Copy size={12} /> Copy Claude Code command
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-copy-config"
          onClick={() =>
            void run('Copying', async () =>
              copy((await ipc.invoke('mcp:clientConfig')).json, 'Config for other clients'),
            )
          }
        >
          <Copy size={12} /> Copy config for other clients
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-reset-token"
          disabled={busy !== null}
          onClick={() =>
            void run('Resetting the token', async () => {
              const ok = await confirmDialog({
                title: 'Reset the access token?',
                description:
                  'Connected agents lose access. Claude Code is connected again automatically; other clients need the new config.',
                confirmLabel: 'Reset',
                tone: 'warning',
              });
              if (!ok) return;
              const r = await ipc.invoke('mcp:resetToken');
              if (r && !r.ok) notify('error', 'Connecting Claude Code again failed', { description: r.output });
              else notify('success', 'The access token was reset');
            })
          }
        >
          <KeyRound size={12} /> Reset token
        </Button>
      </div>
      <p className="mt-2.5 max-w-[720px] text-small text-fg-muted">
        One server for every agent. Tools of plugins appear and disappear as you turn plugins on and off; agents that
        support live tool updates see the change at once, others in their next session. The agents' tool{' '}
        <span className="font-mono">oxy_capabilities</span> always lists the current tools.
      </p>
    </div>
  );
}

function ToolRow({
  tool,
  disabled,
  policies,
}: {
  tool: McpToolInfo;
  disabled: readonly string[];
  policies: Readonly<Record<string, McpPolicy>>;
}) {
  return (
    <div
      data-testid="mcp-tool-row"
      data-name={tool.name}
      data-listed={tool.listed ? 'true' : 'false'}
      className="flex items-start gap-3 border-b border-line-subtle py-2 last:border-b-0"
    >
      <input
        type="checkbox"
        data-testid="mcp-tool-enabled"
        aria-label={`Offer ${tool.name} to agents`}
        checked={tool.enabled}
        onChange={(e) => void update({ 'mcp.tools.disabled': toggleTool(disabled, tool.name, e.target.checked) })}
        className="mt-1 accent-(--accent)"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('font-medium', tool.enabled ? 'text-fg' : 'text-fg-muted')}>
            {tool.title ?? tool.name}
          </span>
          <span className="font-mono text-small text-fg-muted">{tool.name}</span>
        </div>
        <p className="line-clamp-2 max-w-[720px] text-small text-fg-secondary" title={tool.description}>
          {tool.description}
        </p>
        {tool.problem && (
          <p data-testid="mcp-tool-problem" className="text-small text-warning">
            {tool.problem}
          </p>
        )}
      </div>
      <select
        data-testid="mcp-tool-policy"
        aria-label={`When agents use ${tool.name}`}
        value={tool.policy}
        disabled={!tool.enabled}
        onChange={(e) => void update({ 'mcp.tools.policy': withPolicy(policies, tool, e.target.value as McpPolicy) })}
        className="h-7 w-44 flex-none rounded-control border border-line bg-input px-2 text-ui text-fg disabled:opacity-60"
      >
        {(Object.keys(POLICY_LABELS) as McpPolicy[]).map((p) => (
          <option key={p} value={p}>
            {POLICY_LABELS[p]}
            {p === tool.defaultPolicy ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

const OUTCOME_BADGES: Record<
  McpCallLogEntry['outcome'],
  { variant: 'process' | 'danger' | 'warning' | 'neutral'; label: string }
> = {
  ok: { variant: 'process', label: 'ok' },
  error: { variant: 'danger', label: 'error' },
  denied: { variant: 'warning', label: 'denied' },
  cancelled: { variant: 'neutral', label: 'cancelled' },
};

function CallLog({ log }: { log: readonly McpCallLogEntry[] }) {
  return (
    <section data-testid="mcp-log">
      <div className="flex items-center gap-2 border-b border-line-subtle py-1.5">
        <h3 className="oxy-label flex-1">Recent calls</h3>
        {log.length > 0 && (
          <Button size="sm" variant="ghost" data-testid="mcp-log-clear" onClick={() => void ipc.invoke('mcp:clearLog')}>
            <Trash2 size={11} /> Clear
          </Button>
        )}
      </div>
      {log.length === 0 ? (
        <p className="py-2 text-small text-fg-muted">No tool calls yet. Arguments and results are never recorded.</p>
      ) : (
        <div className="max-h-72 overflow-auto">
          {log.map((e) => (
            <div
              key={e.id}
              data-testid="mcp-log-row"
              data-tool={e.tool}
              data-outcome={e.outcome}
              className="flex items-center gap-3 border-b border-line-subtle py-1 text-small last:border-b-0"
              title={e.error}
            >
              <span className="w-16 flex-none font-mono text-fg-muted">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="w-52 flex-none truncate font-mono text-fg">{e.tool}</span>
              <span className="min-w-0 flex-1 truncate text-fg-secondary">{e.caller ?? 'Unknown caller'}</span>
              <span className="w-16 flex-none text-right font-mono text-fg-muted">{e.durationMs} ms</span>
              <Badge variant={OUTCOME_BADGES[e.outcome].variant}>{OUTCOME_BADGES[e.outcome].label}</Badge>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Claude Code is asked once per session whether it knows the server (it runs the `claude` CLI). */
let claudeChecked = false;

/** Settings → Agent Tools: the MCP server, the tools agents get (on/off, allow/ask/block) and recent calls. */
export function AgentToolsView() {
  const state = useMcpStore((s) => s.state);
  const settings = useSettingsStore((s) => s.settings);
  useEffect(() => {
    void useMcpStore.getState().load();
    if (!claudeChecked) {
      claudeChecked = true;
      void ipc.invoke('mcp:checkClaude').catch(() => null);
    }
  }, []);
  const groups = useMemo(() => groupTools(state?.tools ?? []), [state?.tools]);
  if (!state || !settings) return null;
  const disabled = settings['mcp.tools.disabled'];
  const policies = settings['mcp.tools.policy'];
  return (
    <div data-testid="agent-tools" className="mb-4 flex flex-col gap-4 pt-2">
      <ServerStatus />
      <section data-testid="mcp-tools">
        <h3 className="oxy-label border-b border-line-subtle py-1.5">Tools agents can use</h3>
        {groups.map((g) => (
          <div key={g.source} data-testid="mcp-tool-group" data-source={g.source} className="mt-2">
            <div className="text-small font-medium text-fg-secondary">{g.source}</div>
            {g.tools.map((t) => (
              <ToolRow key={t.name} tool={t} disabled={disabled} policies={policies} />
            ))}
          </div>
        ))}
      </section>
      <CallLog log={state.log} />
    </div>
  );
}
