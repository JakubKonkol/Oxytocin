import { AlertTriangle, Copy, Play, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import {
  AI_ACCOUNT_AGENTS,
  AI_ACCOUNT_HOME_VARIABLES,
  accountAlias,
  accountLabel,
  type AgentAccount,
  type AgentAccountMode,
  type AiAccountAgent,
  type AiAgentsState,
  agentName,
  aiAccountLaunchId,
  validateAccountName,
} from '@shared/domain/ai-agents';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { confirmDialog } from '../../stores/dialog-store';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { Check, Field, input, Section, Segmented } from '../projects/settings/controls';
import { accountTitle, withHidden } from './ai-agents-model';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const MODES: Record<AgentAccountMode, { label: string; text: (agent: AiAccountAgent) => string }> = {
  shared: {
    label: 'Shared setup',
    text: (agent) =>
      agent === 'claude'
        ? 'Uses the main account’s global CLAUDE.md, agents, skills, commands, settings and plugins. The sign-in, sessions, history and project memory stay separate.'
        : agent === 'codex'
          ? 'Uses the main account’s AGENTS.md, config.toml (settings and MCP servers), prompts and skills. The sign-in, sessions and history stay separate.'
          : 'Uses the main account’s GEMINI.md, commands and extensions, and starts with a copy of its settings. The sign-in and chats stay separate.',
  },
  isolated: { label: 'Isolated', text: (agent) => `A completely separate ${agentName(agent)}: nothing is shared.` },
};

function AddAccountForm({
  agent,
  accounts,
  onCreate,
  onCancel,
}: {
  agent: AiAccountAgent;
  accounts: readonly AgentAccount[];
  onCreate: (name: string, mode: AgentAccountMode) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<AgentAccountMode>('shared');
  const [busy, setBusy] = useState(false);
  const problem = name.trim() ? validateAccountName(name, agent, accounts) : undefined;
  const submit = async () => {
    if (!name.trim() || problem) return;
    setBusy(true);
    try {
      await onCreate(name, mode);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="ai-account-form"
      className="flex flex-col gap-2 rounded-card border border-line-subtle p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Name" hint={problem ?? 'Shown in the + menu, e.g. "Work". The e-mail appears once you sign in.'}>
        <input
          data-testid="ai-account-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(input, problem && 'border-danger')}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-small font-medium text-fg-secondary">Setup</span>
        <Segmented
          label="Setup"
          testId="ai-account-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'shared', label: `${MODES.shared.label} (recommended)` },
            { value: 'isolated', label: MODES.isolated.label },
          ]}
        />
        <span className="max-w-[760px] text-small text-fg-muted">{MODES[mode].text(agent)}</span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          data-testid="ai-account-create"
          disabled={busy || !name.trim() || !!problem}
        >
          <Plus size={12} /> Create and sign in
        </Button>
      </div>
    </form>
  );
}

function AccountRow({
  account,
  state,
  onStart,
  onHidden,
}: {
  account: AgentAccount;
  state: AiAgentsState;
  onStart: () => void;
  onHidden: (hidden: string[]) => void;
}) {
  const logins = state.accountsInfo.logins[account.id] ?? [];
  const notes = state.accountsInfo.notes[account.id] ?? [];
  const launchId = aiAccountLaunchId(account.id);
  const copyAlias = async () => {
    const alias = accountAlias(account, currentPlatform() === 'win32' ? 'powershell' : 'posix');
    try {
      await ipc.invoke('clipboard:writeText', { text: alias });
      notify('success', 'Shell alias copied', { description: alias });
    } catch (e) {
      notify('error', 'Could not copy', { description: errorText(e) });
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove ${accountTitle(account)}?`,
      description:
        'Its folder is deleted: the sign-in, sessions, history and project memory of this account. The main account and what it shares are not touched.',
      details: [account.home],
      confirmLabel: 'Remove account',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ipc.invoke('aiAgents:removeAccount', { id: account.id });
      notify('success', `${accountTitle(account)} removed`);
    } catch (e) {
      notify('error', 'Could not remove the account', { description: errorText(e) });
    }
  };
  return (
    <div
      data-testid="ai-account-row"
      data-id={account.id}
      className="flex flex-col gap-1 border-t border-line-subtle py-2 first:border-t-0"
    >
      <div className="grid grid-cols-[minmax(160px,220px)_1fr_auto] items-start gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-ui text-fg">
            <UserRound size={14} className="flex-none text-agent" />
            <span className="truncate">{account.name}</span>
          </span>
          <span className="text-small text-fg-muted">{MODES[account.mode].label}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-ui" data-testid="ai-account-login">
            {logins.length === 0 ? (
              <span className="text-fg-muted">Not signed in yet: start it and sign in</span>
            ) : (
              <>
                <span className="truncate text-fg">{accountLabel({ accounts: logins })}</span>
                {logins[0]?.plan && <Badge variant="active">{logins[0].plan}</Badge>}
              </>
            )}
          </span>
          <span className="truncate font-mono text-small text-fg-muted" title={account.home}>
            {account.home}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Check
            checked={!state.hidden.includes(launchId)}
            onChange={(show) => onHidden(withHidden(state.hidden, launchId, show))}
            testId={`ai-account-menu-${account.id}`}
          >
            In + menu
          </Check>
          <Button size="sm" data-testid="ai-account-start" onClick={onStart}>
            <Play size={12} /> {logins.length === 0 ? 'Sign in' : 'Start'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="ai-account-alias"
            title="Copy a shell alias"
            onClick={() => void copyAlias()}
          >
            <Copy size={12} /> Alias
          </Button>
          <Button size="sm" variant="ghost" data-testid="ai-account-remove" onClick={() => void remove()}>
            <Trash2 size={12} /> Remove
          </Button>
        </div>
      </div>
      {notes.length > 0 && (
        <ul data-testid="ai-account-notes" className="pl-5 text-small text-warning">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Settings → AI Agents → Accounts: the main account of Claude Code, Codex CLI and Gemini CLI, and accounts added
 * next to it (a folder of their own, signed in separately, usable at the same time in other terminals).
 */
export function AccountsSection({
  state,
  start,
  saveHidden,
}: {
  state: AiAgentsState;
  start: (launchId: string, name: string) => void;
  saveHidden: (hidden: string[]) => void;
}) {
  const [adding, setAdding] = useState<AiAccountAgent | null>(null);

  const create = async (agent: AiAccountAgent, name: string, mode: AgentAccountMode) => {
    try {
      const next = await ipc.invoke('aiAgents:addAccount', { agent, name, mode });
      setAdding(null);
      const account = next.accounts.find((a) => a.agent === agent && a.name === name.trim());
      notify('success', `${agentName(agent)} account added`, {
        description: 'Sign in in its terminal; the e-mail shows up here afterwards.',
      });
      if (account) start(aiAccountLaunchId(account.id), accountTitle(account));
    } catch (e) {
      notify('error', 'Could not add the account', { description: errorText(e) });
    }
  };

  return (
    <Section title="Accounts">
      <p className="max-w-[760px] text-small text-fg-muted">
        Add another account of Claude Code, Codex CLI or Gemini CLI — e.g. a work subscription next to your own. Each
        added account has a folder of its own, signs in separately and runs at the same time as the others; the main
        account stays exactly as it is. Use accounts you are entitled to, under each provider’s terms.
      </p>
      <div className="flex flex-col gap-3" data-testid="ai-accounts">
        {AI_ACCOUNT_AGENTS.map((agent) => {
          const detected = state.agents.find((a) => a.id === agent);
          const accounts = state.accounts.filter((a) => a.agent === agent);
          const variable = AI_ACCOUNT_HOME_VARIABLES[agent];
          const main = detected ? accountLabel(detected) : undefined;
          return (
            <div
              key={agent}
              data-testid="ai-accounts-agent"
              data-agent={agent}
              className="flex flex-col gap-1 rounded-card border border-line-subtle p-3"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-ui font-medium text-fg">
                  {agentName(agent)}
                  {!detected && state.detectedAt !== null && (
                    <span className="ml-2 text-small font-normal text-fg-muted">not found on PATH</span>
                  )}
                </span>
                <Button
                  size="sm"
                  data-testid={`ai-account-add-${agent}`}
                  disabled={adding === agent}
                  onClick={() => setAdding(agent)}
                >
                  <Plus size={12} /> Add account
                </Button>
              </div>
              <div
                className="grid grid-cols-[minmax(160px,220px)_1fr] items-start gap-3 py-1"
                data-testid="ai-account-main"
              >
                <span className="flex items-center gap-1.5 text-ui text-fg">
                  <UserRound size={14} className="flex-none text-fg-muted" /> Main account
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-ui text-fg">{main ?? 'Not signed in'}</span>
                  <span className="truncate font-mono text-small text-fg-muted">
                    {state.accountsInfo.mainHomes[agent] ?? ''}
                  </span>
                </div>
              </div>
              {accounts.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  state={state}
                  onStart={() => start(aiAccountLaunchId(a.id), accountTitle(a))}
                  onHidden={saveHidden}
                />
              ))}
              {accounts.length > 0 && state.accountsInfo.overridden.includes(variable) && (
                <p className="flex items-start gap-1.5 text-small text-warning" data-testid="ai-account-overridden">
                  <AlertTriangle size={12} className="mt-0.5 flex-none" />
                  {variable} is set in your environment. If your shell profile exports it, it replaces the account’s
                  folder in the account’s terminals.
                </p>
              )}
              {adding === agent && (
                <AddAccountForm
                  agent={agent}
                  accounts={state.accounts}
                  onCreate={(name, mode) => create(agent, name, mode)}
                  onCancel={() => setAdding(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
