import { Bot, Cpu, Loader2, Play, Plus, RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useState } from 'react';
import {
  AI_AGENT_CATALOG,
  AI_PROVIDER_PRESETS,
  type AiProfile,
  aiAgentLaunchId,
  aiProfileLaunchId,
  type DetectedAiAgent,
  newProfile,
  presetOf,
  validateProfiles,
} from '@shared/domain/ai-agents';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../stores/settings-store';
import { ipc } from '../../lib/ipc-client';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { newTerminal } from '../layout/layout-commands';
import { getActiveWorkspace } from '../layout/workspace-registry';
import { Check, Field, input, SecretInput, Section } from '../projects/settings/controls';
import { AccountsSection } from './AccountsSection';
import { agoText, profileDetail, profileSecretChanges, withHidden } from './ai-agents-model';
import { useAiAgentsStore } from './ai-agents-store';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type KeyEdits = Record<string, { value: string } | { remove: true }>;
/** A change to a profile; `undefined` removes an optional field. */
type ProfilePatch = { [K in keyof AiProfile]?: AiProfile[K] | undefined };

const METHOD_LABELS = { oauth: 'signed in', 'api-key': 'API key', local: 'local', other: '' } as const;

function LaunchCommands() {
  const saved = useSettingsStore((s) => s.settings?.['aiAgents.commands']);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const values = draft ?? saved ?? {};
  const save = async () => {
    setSaving(true);
    try {
      await ipc.invoke('settings:update', { 'aiAgents.commands': values });
      setDraft(null);
      notify('success', 'Agent launch commands saved');
    } catch (e) {
      notify('error', 'Could not save launch commands', { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Section
      title="Launch commands"
      action={
        <Button size="sm" disabled={!draft || saving} onClick={() => void save()} data-testid="ai-commands-save">
          <Save size={12} /> Save commands
        </Button>
      }
    >
      <p className="text-small text-fg-muted">
        Commands for new sessions, including added accounts and API profiles. Leave empty for the default. Existing
        sessions keep running.
      </p>
      <div className="grid grid-cols-2 items-center gap-2">
        {AI_AGENT_CATALOG.filter((a) => a.category === 'agent').map((a) => (
          <Field key={a.id} label={a.name}>
            <input
              aria-label={`${a.name} launch command`}
              data-testid={`ai-command-${a.id}`}
              className={cn(input, 'font-mono')}
              placeholder={a.command}
              value={values[a.id] ?? ''}
              maxLength={2000}
              onChange={(e) => setDraft({ ...values, [a.id]: e.target.value })}
            />
          </Field>
        ))}
      </div>
    </Section>
  );
}

function start(launchId: string, name: string): void {
  const ws = getActiveWorkspace();
  if (!ws) {
    notify('info', 'Open a project to start an agent');
    return;
  }
  void newTerminal(ws.api, ws.projectId, launchId).catch((e: unknown) =>
    notify('error', `Could not start ${name}`, { description: errorText(e) }),
  );
}

function AgentRow({
  agent,
  shown,
  onShow,
}: {
  agent: DetectedAiAgent;
  shown: boolean;
  onShow: (show: boolean) => void;
}) {
  return (
    <div
      data-testid="ai-agent-row"
      data-id={agent.id}
      className="grid grid-cols-[minmax(160px,220px)_1fr_auto_auto] items-start gap-3 border-t border-line-subtle py-2 first:border-t-0"
    >
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 text-ui text-fg">
          <Bot size={14} className="flex-none text-agent" />
          <span className="truncate">{agent.name}</span>
          {agent.legacy && <Badge variant="neutral">Legacy</Badge>}
        </span>
        <span className="truncate text-small text-fg-muted" title={agent.path}>
          {agent.version ?? agent.command}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5" data-testid="ai-agent-accounts">
        {agent.accounts.length === 0 && <span className="text-small text-fg-muted">No account found</span>}
        {agent.accounts.map((a) => (
          <span key={`${a.method}:${a.label}`} className="flex min-w-0 items-center gap-1.5 text-ui">
            <span className="truncate text-fg" data-testid="ai-agent-account">
              {a.label}
            </span>
            {a.plan && <Badge variant="active">{a.plan}</Badge>}
            {METHOD_LABELS[a.method] && (
              <span className="flex-none text-small text-fg-muted">{METHOD_LABELS[a.method]}</span>
            )}
            {a.detail && <span className="truncate text-small text-fg-muted">· {a.detail}</span>}
          </span>
        ))}
      </div>
      <Check checked={shown} onChange={onShow} testId={`ai-agent-menu-${agent.id}`}>
        In + menu
      </Check>
      <Button
        size="sm"
        data-testid={`ai-agent-start-${agent.id}`}
        onClick={() => start(aiAgentLaunchId(agent.id), agent.name)}
      >
        <Play size={12} /> Start
      </Button>
    </div>
  );
}

function RuntimeRow({ runtime, onProfile }: { runtime: DetectedAiAgent; onProfile: () => void }) {
  return (
    <div
      data-testid="ai-runtime-row"
      data-id={runtime.id}
      className="flex items-center gap-3 border-t border-line-subtle py-2 first:border-t-0"
    >
      <Cpu size={14} className="flex-none text-fg-muted" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui text-fg">{runtime.name}</span>
        <span className="truncate text-small text-fg-muted">
          {runtime.running
            ? `Running at ${runtime.url ?? ''} · ${runtime.models?.length ?? 0} model${runtime.models?.length === 1 ? '' : 's'}${runtime.models?.length ? `: ${runtime.models.slice(0, 5).join(', ')}${runtime.models.length > 5 ? '…' : ''}` : ''}`
            : 'Installed, not running'}
        </span>
      </div>
      <Button size="sm" data-testid={`ai-runtime-profile-${runtime.id}`} onClick={onProfile}>
        <Plus size={12} /> Claude Code profile
      </Button>
    </div>
  );
}

function ProfileForm({
  profile,
  set,
  remove,
  keyState,
  setKey,
  runtimeModels,
}: {
  profile: AiProfile;
  set: (patch: ProfilePatch) => void;
  remove: () => void;
  keyState: 'set' | 'unset' | 'changed';
  setKey: (edit: { value: string } | { remove: true } | null) => void;
  runtimeModels: string[];
}) {
  const preset = presetOf(profile.provider);
  const listId = `ai-models-${profile.id}`;
  return (
    <div data-testid="ai-profile-form" className="flex flex-col gap-2 rounded-card border border-line-subtle p-3">
      <div className="grid grid-cols-[1fr_220px_auto] items-end gap-2">
        <Field label="Name" hint="Shown in the + menu.">
          <input
            data-testid="ai-profile-name"
            value={profile.name}
            onChange={(e) => set({ name: e.target.value })}
            className={input}
          />
        </Field>
        <Field label="Provider">
          <select
            data-testid="ai-profile-provider"
            value={profile.provider}
            onChange={(e) => {
              const next = presetOf(e.target.value);
              // The base URL follows the provider unless it was typed by hand.
              const typed = profile.baseUrl && profile.baseUrl !== preset.baseUrl;
              set({ provider: next.id, ...(typed ? {} : { baseUrl: next.baseUrl }) });
            }}
            className={input}
          >
            {AI_PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Button size="sm" variant="ghost" data-testid="ai-profile-remove" onClick={remove}>
          <Trash2 size={12} /> Remove
        </Button>
      </div>
      <Field label="Base URL" hint="An Anthropic-compatible API (ANTHROPIC_BASE_URL).">
        <input
          data-testid="ai-profile-url"
          value={profile.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          className={cn(input, 'font-mono')}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Model" hint={preset.modelHint}>
          <input
            data-testid="ai-profile-model"
            list={listId}
            value={profile.model ?? ''}
            onChange={(e) => set({ model: e.target.value || undefined })}
            className={cn(input, 'font-mono')}
          />
        </Field>
        <Field label="Fast model" hint="For quick background work; empty: the model.">
          <input
            data-testid="ai-profile-fast-model"
            list={listId}
            value={profile.fastModel ?? ''}
            onChange={(e) => set({ fastModel: e.target.value || undefined })}
            className={cn(input, 'font-mono')}
          />
        </Field>
        <datalist id={listId}>
          {runtimeModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <SecretInput
        label="API key"
        testId="ai-profile-key"
        state={keyState}
        placeholder={preset.local ? 'Not needed' : undefined}
        hint={`${preset.keyHint}. Stored encrypted; Claude Code gets it as ANTHROPIC_AUTH_TOKEN.`}
        onSet={(value) => setKey({ value })}
        onRemove={() => setKey({ remove: true })}
        onReset={() => setKey(null)}
      />
    </div>
  );
}

/** Settings → AI Agents: installed agent CLIs with their accounts, local runtimes and API profiles. */
export function AiAgentsView() {
  const state = useAiAgentsStore((s) => s.state);
  const detecting = useAiAgentsStore((s) => s.detecting);
  const ensure = useAiAgentsStore((s) => s.ensure);
  const detect = useAiAgentsStore((s) => s.detect);
  const [draft, setDraft] = useState<AiProfile[] | null>(null);
  const [keys, setKeys] = useState<KeyEdits>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Who the added accounts are signed in with may have changed outside Oxytocin.
    void ensure().then(() => ipc.invoke('aiAgents:refreshAccounts').catch(() => undefined));
  }, [ensure]);
  // A save or a detection elsewhere replaces an unchanged draft.
  const profiles = draft ?? state?.profiles ?? [];
  if (!state) return <div className="py-3 text-fg-muted">Loading…</div>;

  const agents = state.agents.filter((a) => a.category === 'agent');
  const runtimes = state.agents.filter((a) => a.category === 'runtime');
  const missing = AI_AGENT_CATALOG.filter(
    (k) => k.category === 'agent' && !k.legacy && !agents.some((a) => a.id === k.id),
  );
  const models = runtimes.flatMap((r) => r.models ?? []);
  const dirty =
    (draft !== null && JSON.stringify(draft) !== JSON.stringify(state.profiles)) ||
    profileSecretChanges(profiles, keys).length > 0;
  const problems = validateProfiles(profiles);

  const save = async (hidden: string[], withProfiles: boolean) => {
    setSaving(true);
    try {
      await ipc.invoke('aiAgents:save', {
        profiles: withProfiles ? profiles : state.profiles,
        hidden,
        secrets: withProfiles ? profileSecretChanges(profiles, keys) : [],
      });
      if (withProfiles) {
        setDraft(null);
        setKeys({});
        notify('success', 'AI profiles saved');
      }
    } catch (e) {
      notify('error', 'Could not save', { description: errorText(e) });
    } finally {
      setSaving(false);
    }
  };
  const addProfile = (provider: string, model?: string) =>
    setDraft([...profiles, newProfile(profiles, provider, model)]);
  const runDetect = () =>
    void detect().then(
      (s) =>
        notify('success', 'AI agents detected', {
          description:
            s.agents
              .filter((a) => a.category === 'agent')
              .map((a) => a.name)
              .join(', ') || 'No agents found on PATH.',
        }),
      (e: unknown) => notify('error', 'Detection failed', { description: errorText(e) }),
    );

  return (
    <div data-testid="ai-agents-view" className="mb-4 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="oxy-label border-b border-line-subtle py-1.5">AI Agents</h2>
        <p className="max-w-[760px] text-small text-fg-muted">
          The coding agents installed on this computer and the accounts they are signed in with. Start them from the{' '}
          <strong>+</strong> menu of a workspace (<em>AI agents</em>): they run exactly as when you type their command
          in a terminal, with your usual login and settings. Profiles run Claude Code against another
          Anthropic-compatible API — a provider such as GLM, Kimi or OpenRouter, or a local model in Ollama or
          llama.cpp.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" variant="primary" data-testid="ai-detect" disabled={detecting} onClick={runDetect}>
            {detecting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Detect AI agents
          </Button>
          <span className="text-small text-fg-muted" data-testid="ai-detected-at">
            {detecting ? 'Looking for agents and accounts…' : `Last checked: ${agoText(state.detectedAt)}`}
          </span>
        </div>
      </div>

      <Section title="Coding agents">
        <div data-testid="ai-agents-list">
          {agents.length === 0 && (
            <p className="text-small text-fg-muted">
              {state.detectedAt === null ? 'Not checked yet: press Detect AI agents.' : 'No agents found on PATH.'}
            </p>
          )}
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              shown={!state.hidden.includes(aiAgentLaunchId(a.id))}
              onShow={(show) => void save(withHidden(state.hidden, aiAgentLaunchId(a.id), show), false)}
            />
          ))}
        </div>
        {missing.length > 0 && state.detectedAt !== null && (
          <p className="text-small text-fg-muted">Not found: {missing.map((m) => m.name).join(', ')}.</p>
        )}
      </Section>

      <LaunchCommands />
      <AccountsSection state={state} start={start} saveHidden={(hidden) => void save(hidden, false)} />

      {runtimes.length > 0 && (
        <Section title="Local models">
          <div data-testid="ai-runtimes-list">
            {runtimes.map((r) => (
              <RuntimeRow key={r.id} runtime={r} onProfile={() => addProfile(r.id, r.models?.[0])} />
            ))}
          </div>
        </Section>
      )}

      <Section
        title="API & local model profiles"
        action={
          <div className="flex items-center gap-2">
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="ai-profiles-revert"
                onClick={() => {
                  setDraft(null);
                  setKeys({});
                }}
              >
                <RotateCcw size={12} /> Revert
              </Button>
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" data-testid="ai-profile-add">
                  <Plus size={12} /> Add profile
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-[60] w-64 rounded-card border border-line bg-elevated p-1 shadow-elevated"
                >
                  {AI_PROVIDER_PRESETS.map((p) => (
                    <DropdownMenu.Item
                      key={p.id}
                      data-testid={`ai-profile-add-${p.id}`}
                      onSelect={() => addProfile(p.id)}
                      className="flex cursor-default flex-col rounded-control px-2 py-1 outline-none data-[highlighted]:bg-card-hover"
                    >
                      <span className="text-ui text-fg">{p.label}</span>
                      {p.baseUrl && <span className="truncate font-mono text-small text-fg-muted">{p.baseUrl}</span>}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Button
              size="sm"
              variant="primary"
              data-testid="ai-profiles-save"
              disabled={!dirty || saving || problems.length > 0}
              onClick={() => void save(state.hidden, true)}
            >
              <Save size={12} /> Save
            </Button>
          </div>
        }
      >
        <p className="max-w-[760px] text-small text-fg-muted">
          A profile starts <span className="font-mono">claude</span> with ANTHROPIC_BASE_URL, the API key and the model
          set for that terminal only; your Claude Code login and settings stay as they are.
          {!state.encrypted && ' API keys are only obfuscated on this system (no keyring).'}
        </p>
        {dirty && problems.length > 0 && (
          <ul data-testid="ai-profiles-problems" className="text-small text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2" data-testid="ai-profiles-list">
          {profiles.length === 0 && <p className="text-small text-fg-muted">No profiles yet.</p>}
          {profiles.map((p) => {
            const edit = keys[p.id];
            const keyState = edit
              ? 'remove' in edit
                ? 'unset'
                : 'changed'
              : state.keys.includes(p.id)
                ? 'set'
                : 'unset';
            const saved = state.profiles.some((x) => x.id === p.id);
            return (
              <div key={p.id} className="flex flex-col gap-1.5">
                <ProfileForm
                  profile={p}
                  set={(patch) =>
                    setDraft(
                      profiles.map((x) => {
                        if (x.id !== p.id) return x;
                        const next: Record<string, unknown> = { ...x, ...patch };
                        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
                        return next as AiProfile;
                      }),
                    )
                  }
                  remove={() => setDraft(profiles.filter((x) => x.id !== p.id))}
                  keyState={keyState}
                  setKey={(e) =>
                    setKeys((k) => {
                      const next = { ...k };
                      if (e) next[p.id] = e;
                      else delete next[p.id];
                      return next;
                    })
                  }
                  runtimeModels={models}
                />
                <div className="flex items-center gap-3 px-1 text-small text-fg-muted">
                  <Check
                    checked={!state.hidden.includes(aiProfileLaunchId(p.id))}
                    disabled={!saved}
                    onChange={(show) => void save(withHidden(state.hidden, aiProfileLaunchId(p.id), show), false)}
                  >
                    In + menu
                  </Check>
                  <span className="flex-1 truncate">{profileDetail(p)}</span>
                  <Button
                    size="sm"
                    data-testid="ai-profile-start"
                    disabled={!saved || dirty}
                    title={!saved || dirty ? 'Save the profile first' : undefined}
                    onClick={() => start(aiProfileLaunchId(p.id), p.name)}
                  >
                    <Play size={12} /> Start
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
