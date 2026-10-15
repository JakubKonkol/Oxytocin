import { Copy, KeyRound, Link2, Link2Off, RefreshCw, Trash2 } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
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

type Run = (what: string, fn: () => Promise<void>) => Promise<void>;

function useBusy(): { busy: string | null; run: Run } {
  const [busy, setBusy] = useState<string | null>(null);
  const run: Run = async (what, fn) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      notify('error', `${what} failed`, { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** Claude Code is asked once per session whether it knows the server (it runs the `claude` CLI). */
let claudeChecked = false;

/** Asks the agents whether they know the server at its current address (Claude Code: once per session). */
async function checkClients(force: boolean): Promise<void> {
  const claude = force || !claudeChecked ? ipc.invoke('mcp:checkClaude') : null;
  claudeChecked = true;
  await Promise.all([claude, ipc.invoke('mcp:checkCodex')]);
}

function ServerStatus() {
  const status = useMcpStore((s) => s.state?.status);
  const { busy, run } = useBusy();
  if (!status) return null;
  const running = status.port !== null;
  return (
    <div data-testid="mcp-status" className="rounded-card border border-line-subtle bg-surface/60 p-3">
      <div className="flex items-center gap-2">
        <StatusDot state={status.error ? 'error' : running ? 'running' : 'idle'} />
        <span className="min-w-0 flex-1 font-medium text-fg" data-testid="mcp-status-text">
          {status.error
            ? status.error
            : running
              ? `MCP server running at ${status.url}`
              : status.enabled
                ? 'MCP server starting…'
                : 'MCP server turned off'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-check"
          disabled={busy !== null}
          onClick={() => void run('Checking the agents', () => checkClients(true))}
        >
          <RefreshCw size={12} /> Check
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
                  'Connected agents lose access. Claude Code and Codex are connected again automatically; other clients need the new config.',
                confirmLabel: 'Reset',
                tone: 'warning',
              });
              if (!ok) return;
              const r = await ipc.invoke('mcp:resetToken');
              if (r && !r.ok) notify('error', 'Connecting the agents again failed', { description: r.output });
              else notify('success', 'The access token was reset');
            })
          }
        >
          <KeyRound size={12} /> Reset token
        </Button>
      </div>
      {running && (
        <div className="mt-1 text-small text-fg-muted" data-testid="mcp-status-detail">
          {status.sessions} connected client{status.sessions === 1 ? '' : 's'} · {status.calls} tool call
          {status.calls === 1 ? '' : 's'}
        </div>
      )}
      <p className="mt-2 max-w-[720px] text-small text-fg-muted">
        One server for every agent. Tools of plugins appear and disappear as you turn plugins on and off; agents that
        support live tool updates see the change at once, others in their next session. The agents' tool{' '}
        <span className="font-mono">oxy_capabilities</span> always lists the current tools.
      </p>
    </div>
  );
}

function ConnectionBadge({ connected, unknown }: { connected: boolean | null; unknown: string }) {
  return connected === true ? (
    <Badge variant="process">connected</Badge>
  ) : connected === false ? (
    <Badge variant="neutral">not connected</Badge>
  ) : (
    <Badge variant="warning" title={unknown}>
      unknown
    </Badge>
  );
}

function ClientRow({
  id,
  name,
  description,
  connected,
  children,
}: {
  id: string;
  name: string;
  description: ReactNode;
  connected?: boolean | null;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="mcp-client"
      data-client={id}
      data-connected={connected === undefined ? undefined : String(connected)}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle py-2.5 last:border-b-0"
    >
      <div className="min-w-[240px] flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{name}</span>
          {connected !== undefined && (
            <ConnectionBadge
              connected={connected}
              unknown={`Oxytocin could not tell whether ${name} knows the server (is it installed?).`}
            />
          )}
        </div>
        <p className="max-w-[640px] text-small text-fg-muted">{description}</p>
      </div>
      <div className="flex flex-none flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** The agents that use the server: Claude Code and Codex are connected by Oxytocin, others get a config to copy. */
function Clients() {
  const status = useMcpStore((s) => s.state?.status);
  const { busy, run } = useBusy();
  if (!status) return null;
  const running = status.port !== null;
  const connectClaude = () =>
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
  const connectCodex = () =>
    run('Connecting Codex', async () => {
      const r = await ipc.invoke('mcp:connectCodex');
      if (!r.ok) {
        notify('error', 'Connecting Codex failed', { description: r.output });
        return;
      }
      notify('success', 'Codex is connected', {
        description: `New Codex sessions can use Oxytocin's tools (MCP server "oxytocin"). ${r.output}`,
      });
    });
  return (
    <section data-testid="mcp-clients">
      <h3 className="oxy-label border-b border-line-subtle py-1.5">Agents</h3>
      <ClientRow
        id="claude"
        name="Claude Code"
        connected={status.claudeConnected}
        description={
          <>
            Registered with <span className="font-mono">claude mcp add --scope user</span>: every project, every
            session. Its tools are <span className="font-mono">mcp__oxytocin__…</span>.
          </>
        }
      >
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
            <Link2Off size={12} /> Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            data-testid="mcp-connect"
            disabled={busy !== null || !running}
            onClick={() => void connectClaude()}
          >
            <Link2 size={12} /> {busy === 'Connecting Claude Code' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-copy-command"
          onClick={() =>
            void run('Copying', async () => copy((await ipc.invoke('mcp:clientConfig')).command, 'Command'))
          }
        >
          <Copy size={12} /> Copy command
        </Button>
      </ClientRow>
      <ClientRow
        id="codex"
        name="Codex CLI"
        connected={status.codexConnected}
        description={
          <>
            Added to Codex&apos;s <span className="font-mono">config.toml</span> (in{' '}
            <span className="font-mono">~/.codex</span> or <span className="font-mono">$CODEX_HOME</span>) as{' '}
            <span className="font-mono">[mcp_servers.oxytocin]</span>; the rest of the file stays as it is. New Codex
            sessions see the tools.
          </>
        }
      >
        {status.codexConnected === true ? (
          <Button
            size="sm"
            data-testid="mcp-disconnect-codex"
            disabled={busy !== null}
            onClick={() =>
              void run('Disconnecting Codex', async () => {
                const r = await ipc.invoke('mcp:disconnectCodex');
                if (!r.ok) notify('error', 'Disconnecting Codex failed', { description: r.output });
              })
            }
          >
            <Link2Off size={12} /> Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            data-testid="mcp-connect-codex"
            disabled={busy !== null || !running}
            onClick={() => void connectCodex()}
          >
            <Link2 size={12} /> {busy === 'Connecting Codex' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="mcp-copy-codex"
          onClick={() =>
            void run('Copying', async () => copy((await ipc.invoke('mcp:clientConfig')).codex, 'Codex config'))
          }
        >
          <Copy size={12} /> Copy config.toml entry
        </Button>
      </ClientRow>
      <ClientRow
        id="other"
        name="Other MCP clients"
        description="Cursor, Windsurf, VS Code, Gemini CLI and others: paste the mcpServers JSON into the client's MCP settings."
      >
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
          <Copy size={12} /> Copy JSON config
        </Button>
      </ClientRow>
    </section>
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
        className="h-7 w-56 flex-none rounded-control border border-line bg-input px-2 text-ui text-fg disabled:opacity-60"
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
        <p className="flex-1 text-small text-fg-muted">
          The last 200 calls since Oxytocin started. Results are never recorded; database and API tools keep the query
          or request line.
        </p>
        {log.length > 0 && (
          <Button size="sm" variant="ghost" data-testid="mcp-log-clear" onClick={() => void ipc.invoke('mcp:clearLog')}>
            <Trash2 size={11} /> Clear
          </Button>
        )}
      </div>
      {log.length === 0 ? (
        <p className="py-2 text-small text-fg-muted">No tool calls yet.</p>
      ) : (
        <div className="max-h-72 overflow-auto">
          {log.map((e) => (
            <div
              key={e.id}
              data-testid="mcp-log-row"
              data-tool={e.tool}
              data-outcome={e.outcome}
              className="flex items-center gap-3 border-b border-line-subtle py-1 text-small last:border-b-0"
              title={[e.detail, e.error].filter(Boolean).join('\n') || undefined}
            >
              <span className="w-16 flex-none font-mono text-fg-muted">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="w-52 flex-none truncate font-mono text-fg">{e.tool}</span>
              <span className="min-w-0 flex-1 truncate text-fg-secondary">
                {e.caller ?? 'Unknown caller'}
                {e.detail && <span className="ml-2 font-mono text-fg-muted">{e.detail}</span>}
              </span>
              <span className="w-16 flex-none text-right font-mono text-fg-muted">{e.durationMs} ms</span>
              <Badge variant={OUTCOME_BADGES[e.outcome].variant}>{OUTCOME_BADGES[e.outcome].label}</Badge>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export type AgentToolsTab = 'server' | 'tools' | 'calls';
/** The tab shown when the section opens again (this window session). */
let lastTab: AgentToolsTab = 'server';

const TAB_CLASS =
  '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-2.5 py-1.5 text-ui text-fg-secondary hover:text-fg data-[state=active]:border-line-focus data-[state=active]:text-fg';

/** "12" or "12 of 14" (tools turned off or not offered right now). */
export function toolCount(tools: readonly McpToolInfo[]): string {
  const listed = tools.filter((t) => t.listed).length;
  return listed === tools.length ? String(tools.length) : `${listed} of ${tools.length}`;
}

/**
 * Settings → Agent Tools: the MCP server with the agents it is connected to and its settings (`settings`), the tools
 * agents get (on/off, allow/ask/block) and recent calls, each in a tab.
 */
export function AgentToolsView({ settings: settingRows }: { settings?: ReactNode }) {
  const state = useMcpStore((s) => s.state);
  const settings = useSettingsStore((s) => s.settings);
  const [tab, setTab] = useState<AgentToolsTab>(lastTab);
  useEffect(() => {
    void useMcpStore.getState().load();
    void checkClients(false).catch(() => null);
  }, []);
  const groups = useMemo(() => groupTools(state?.tools ?? []), [state?.tools]);
  if (!state || !settings) return null;
  const disabled = settings['mcp.tools.disabled'];
  const policies = settings['mcp.tools.policy'];
  return (
    <Tabs.Root
      data-testid="agent-tools"
      value={tab}
      onValueChange={(v) => setTab((lastTab = v as AgentToolsTab))}
      className="mb-4 flex flex-col gap-3 pt-1"
    >
      <Tabs.List aria-label="Agent Tools" className="flex flex-none gap-0.5 border-b border-line-subtle">
        <Tabs.Trigger value="server" data-testid="agent-tools-tab-server" className={TAB_CLASS}>
          MCP server
        </Tabs.Trigger>
        <Tabs.Trigger value="tools" data-testid="agent-tools-tab-tools" className={TAB_CLASS}>
          Tools <span className="font-mono text-small text-fg-muted">{toolCount(state.tools)}</span>
        </Tabs.Trigger>
        <Tabs.Trigger value="calls" data-testid="agent-tools-tab-calls" className={TAB_CLASS}>
          Recent calls
          {state.log.length > 0 && <span className="font-mono text-small text-fg-muted">{state.log.length}</span>}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="server" className="flex flex-col gap-4 outline-none">
        <ServerStatus />
        <Clients />
        {settingRows && (
          <section data-testid="mcp-settings">
            <h3 className="oxy-label border-b border-line-subtle py-1.5">Settings</h3>
            {settingRows}
          </section>
        )}
      </Tabs.Content>
      <Tabs.Content value="tools" data-testid="mcp-tools" className="outline-none">
        <p className="max-w-[720px] pb-1 text-small text-fg-muted">
          What agents connected to the server can use. Turn a tool off to hide it from them, or choose whether it runs
          without asking, asks you first or is blocked.
        </p>
        {groups.map((g) => (
          <div key={g.source} data-testid="mcp-tool-group" data-source={g.source} className="mt-2">
            <div className="text-small font-medium text-fg-secondary">{g.source}</div>
            {g.tools.map((t) => (
              <ToolRow key={t.name} tool={t} disabled={disabled} policies={policies} />
            ))}
          </div>
        ))}
      </Tabs.Content>
      <Tabs.Content value="calls" className="outline-none">
        <CallLog log={state.log} />
      </Tabs.Content>
    </Tabs.Root>
  );
}
