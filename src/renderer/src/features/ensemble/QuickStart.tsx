import { Check, Loader2, Play, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EnsembleChecks } from '@shared/domain/ensemble';
import { CLI_INFO } from '@shared/ensemble/clis';
import { validateTask } from '@shared/ensemble/conductor';
import { DEFAULT_QUICK_TEAM, QUICK_ROLES, type QuickRole, rolePreset, titleFromPrompt } from '@shared/ensemble/presets';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { ensembleCommand, useEnsembleStore } from './ensemble-store';
import { AgentAvatar, inputSized } from './ui';

const avatarOf = (preset: QuickRole | 'planner') => {
  const p = rolePreset(preset);
  return { name: p.name, role: { preset: p.preset, label: p.label, color: p.color } };
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The quick start: describe the task once, pick who works on it, start. The planner leads: it breaks the task down,
 * delegates research to the helpers, writes the plan you approve, and the builders carry it out. "Customize first"
 * opens the same task in the builder (models, prompts per role, stages).
 */
export function QuickStart({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [roles, setRoles] = useState<QuickRole[]>([...DEFAULT_QUICK_TEAM.roles]);
  const [approvePlan, setApprovePlan] = useState(DEFAULT_QUICK_TEAM.approvePlan);
  const [testCommand, setTestCommand] = useState('');
  const [busy, setBusy] = useState<'start' | 'customize' | null>(null);
  const [checks, setChecks] = useState<EnsembleChecks | null>(null);
  const [apis, setApis] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    let alive = true;
    void ipc.invoke('ensemble:checks', { projectId, clis: ['claude-code'] }).then(
      (c) => alive && setChecks(c),
      () => undefined,
    );
    void ipc.invoke('resources:get', { projectId }).then(
      (r) => alive && setApis(r.resources.apis.filter((a) => a.agents.exposed).map((a) => a.name)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId]);
  // A project with APIs gets the API researcher, until the user picks the team.
  const team =
    !touched && apis.length && !roles.includes('api-researcher') ? [...roles, 'api-researcher' as const] : roles;

  const toggle = (role: QuickRole) => {
    setTouched(true);
    setRoles(team.includes(role) ? team.filter((r) => r !== role) : [...team, role]);
  };

  const notRepo = checks !== null && !checks.repo.isRepo;
  const writes = team.some((r) => !rolePreset(r).readOnly);
  const claude = checks?.clis.find((c) => c.cli === 'claude-code');
  const problems = [
    ...(claude && !claude.installed
      ? [`Claude Code was not found (${claude.problem ?? 'not on PATH'}): ${CLI_INFO['claude-code'].installHint}`]
      : []),
    ...(checks && !checks.mcp.running
      ? ["Oxytocin's MCP server is not running (Settings → Agent Tools); agents need it to talk to Ensemble."]
      : []),
  ];

  const create = async (start: boolean) => {
    if (!prompt.trim()) return;
    if (start && notRepo && writes) {
      const ok = await confirmDialog({
        title: 'Agents will change files in the project folder',
        description:
          'This project is not a git repository, so the task cannot get a worktree of its own: agents that write change your files directly.',
        confirmLabel: 'Start anyway',
        tone: 'warning',
      });
      if (!ok) return;
    }
    setBusy(start ? 'start' : 'customize');
    try {
      const record = await ipc.invoke('ensemble:createQuick', {
        projectId,
        prompt,
        ...(title.trim() ? { title: title.trim() } : {}),
        team: { roles: team, approvePlan, ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}) },
        ...(notRepo ? { currentCheckout: true } : {}),
      });
      const store = useEnsembleStore.getState();
      store.upsert(record);
      store.select(projectId, record.task.id);
      if (start && validateTask(record.task).length === 0) {
        store.setTab(record.task.id, 'flow');
        await ensembleCommand(record.task.id, { type: 'start' });
      } else store.setTab(record.task.id, 'task');
      onCreated();
    } catch (e) {
      notify('error', 'The task could not be created', { description: message(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="ensemble-quick-start">
      <label className="flex flex-col gap-1">
        <span className="text-small font-medium text-fg-secondary">What should the team do?</span>
        <textarea
          data-testid="ensemble-quick-prompt"
          value={prompt}
          rows={7}
          autoFocus
          placeholder={
            'Describe the task like you would to a colleague: what to build, where, constraints, acceptance criteria.\nE.g. "Show the current weather from the Weather API on the dashboard, in the existing card component."'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create(true);
          }}
          className="resize-y rounded-control border border-line bg-input p-2 text-ui text-fg placeholder:text-fg-muted"
        />
      </label>

      <section className="flex flex-col gap-2">
        <span className="text-small font-medium text-fg-secondary">Team</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Team">
          <span
            className="flex items-center gap-2 rounded-card border border-line-focus bg-focus-tint px-2.5 py-1.5"
            title="Always on: breaks the task down, delegates research and writes the plan"
          >
            <AgentAvatar agent={avatarOf('planner')} size={22} />
            <span className="flex flex-col">
              <span className="font-medium text-fg">Planner</span>
              <span className="text-[11px] text-fg-muted">leads, delegates, plans</span>
            </span>
          </span>
          {QUICK_ROLES.map((role) => {
            const p = rolePreset(role);
            const on = team.includes(role);
            return (
              <button
                key={role}
                type="button"
                aria-pressed={on}
                data-testid={`ensemble-quick-role-${role}`}
                onClick={() => toggle(role)}
                title={p.hint}
                className={cn(
                  'flex items-center gap-2 rounded-card border px-2.5 py-1.5 text-left transition-colors',
                  on ? 'border-line-focus bg-focus-tint' : 'border-line-subtle bg-card opacity-70 hover:opacity-100',
                )}
              >
                <AgentAvatar agent={avatarOf(role)} size={22} />
                <span className="flex flex-col">
                  <span className="font-medium text-fg">{p.label}</span>
                  <span className="text-[11px] text-fg-muted">{p.hint}</span>
                </span>
                {on && <Check size={13} className="text-accent" />}
              </button>
            );
          })}
        </div>
        {team.includes('api-researcher') && (
          <p className="text-small text-fg-muted" data-testid="ensemble-quick-apis">
            {apis.length
              ? `The API researcher can call this project's APIs (${apis.join(', ')}) through Oxytocin, with your access rules.`
              : 'Name the API (a URL or its documentation) in the prompt; APIs in Project settings are called through Oxytocin with your access rules.'}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            data-testid="ensemble-quick-approve-plan"
            checked={approvePlan}
            onChange={(e) => setApprovePlan(e.target.checked)}
          />
          I approve the plan before anyone codes
        </label>
        <label className="flex items-center gap-2 text-fg-secondary">
          Test command
          <input
            data-testid="ensemble-quick-test-command"
            value={testCommand}
            placeholder="optional, e.g. npm test"
            onChange={(e) => setTestCommand(e.target.value)}
            className={cn(inputSized, 'w-44 font-mono')}
          />
        </label>
        <label className="flex items-center gap-2 text-fg-secondary">
          Title
          <input
            data-testid="ensemble-quick-title"
            value={title}
            maxLength={120}
            placeholder={titleFromPrompt(prompt) || 'from the prompt'}
            onChange={(e) => setTitle(e.target.value)}
            className={cn(inputSized, 'w-64')}
          />
        </label>
      </div>

      {(problems.length > 0 || (notRepo && writes)) && (
        <div className="flex flex-col gap-0.5 text-small text-warning" data-testid="ensemble-quick-problems">
          {problems.map((p) => (
            <span key={p}>• {p}</span>
          ))}
          {notRepo && writes && (
            <span>• Not a git repository: the agents work directly in the project folder (no worktree).</span>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-small text-fg-muted">
          Models, prompts per role and stages can be changed in “Customize first”.
        </span>
        <Button
          data-testid="ensemble-quick-customize"
          disabled={!prompt.trim() || busy !== null}
          onClick={() => void create(false)}
        >
          {busy === 'customize' ? <Loader2 size={14} className="animate-spin" /> : <Settings2 size={14} />} Customize
          first
        </Button>
        <Button
          variant="primary"
          data-testid="ensemble-quick-go"
          disabled={!prompt.trim() || busy !== null}
          onClick={() => void create(true)}
          title="Ctrl+Enter"
        >
          {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start
        </Button>
      </div>
    </div>
  );
}
