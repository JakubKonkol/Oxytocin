import { Check, Crown, Loader2, Play, RotateCcw, Settings2, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EnsembleAgent, EnsembleChecks, EnsembleCli, EnsembleCrew, RolePreset } from '@shared/domain/ensemble';
import { CLI_INFO } from '@shared/ensemble/clis';
import { validateTask } from '@shared/ensemble/conductor';
import {
  agentFromPreset,
  crewOf,
  defaultCrew,
  ROLE_PRESETS,
  rolePreset,
  titleFromPrompt,
} from '@shared/ensemble/presets';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { useSettingsStore } from '../../stores/settings-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { notify } from '../../ui/Toast';
import { ensembleCommand, useEnsembleStore } from './ensemble-store';
import { AgentAvatar, inputSized, ModelPicker, modelLabel } from './ui';

const CLIS: EnsembleCli[] = ['claude-code', 'codex', 'gemini-cli', 'opencode'];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One member of the crew editor: who it is, its AI and whether it edits files. */
function MemberRow({
  member,
  lead,
  onChange,
  onLead,
  onRemove,
}: {
  member: EnsembleAgent;
  lead: boolean;
  onChange: (m: EnsembleAgent) => void;
  onLead: () => void;
  onRemove?: (() => void) | undefined;
}) {
  const info = CLI_INFO[member.cli];
  const set = (patch: Partial<EnsembleAgent>) => onChange({ ...member, ...patch });
  return (
    <div
      data-testid="ensemble-crew-member"
      data-member-id={member.id}
      className={cn(
        'flex flex-col gap-2 rounded-card border p-2.5',
        lead ? 'border-line-focus bg-focus-tint' : 'border-line-subtle bg-card',
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar agent={member} size={24} />
        <input
          aria-label="Name"
          data-testid="ensemble-crew-name"
          value={member.name}
          maxLength={40}
          onChange={(e) => set({ name: e.target.value })}
          className={cn(inputSized, 'w-32 font-medium')}
        />
        <select
          aria-label="Role"
          data-testid="ensemble-crew-role"
          value={member.role.preset}
          onChange={(e) => {
            const p = rolePreset(e.target.value as RolePreset);
            set({
              role: { preset: p.preset, label: p.label, color: p.color },
              rolePrompt: p.rolePrompt,
              readOnly: p.readOnly,
              permissionMode: info.permissionModes.includes(p.permissionMode) ? p.permissionMode : 'default',
            });
          }}
          className={cn(inputSized, 'w-40')}
        >
          {ROLE_PRESETS.filter((p) => p.preset !== 'advisor').map((p) => (
            <option key={p.preset} value={p.preset}>
              {p.preset === 'custom' ? 'Custom role' : p.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-small text-fg-secondary" title="The lead gets the task">
          <input
            type="radio"
            name="ensemble-crew-lead"
            data-testid="ensemble-crew-lead"
            checked={lead}
            onChange={onLead}
          />
          Lead
        </label>
        <label className="flex items-center gap-1.5 text-small text-fg-secondary">
          <input
            type="checkbox"
            data-testid="ensemble-crew-edits"
            checked={!member.readOnly}
            onChange={(e) =>
              set({
                readOnly: !e.target.checked,
                // Agents that edit do not stop at every edit for a permission prompt.
                permissionMode:
                  e.target.checked && info.permissionModes.includes('acceptEdits')
                    ? 'acceptEdits'
                    : e.target.checked
                      ? member.permissionMode
                      : 'default',
              })
            }
          />
          Edits files
        </label>
        <span className="flex-1" />
        {onRemove && (
          <IconButton
            label={`Remove ${member.name}`}
            data-testid="ensemble-crew-remove"
            icon={<Trash2 size={13} />}
            onClick={onRemove}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="AI (CLI)"
          data-testid="ensemble-crew-cli"
          value={member.cli}
          onChange={(e) => {
            const cli = e.target.value as EnsembleCli;
            const next = CLI_INFO[cli];
            set({
              cli,
              // Model ids are per CLI: a Claude model means nothing to Codex.
              model: next.models.some((m) => m.id === member.model) ? member.model : undefined,
              effort: next.efforts.includes(member.effort ?? '') ? member.effort : undefined,
              permissionMode: next.permissionModes.includes(member.permissionMode) ? member.permissionMode : 'default',
            });
          }}
          className={cn(inputSized, 'w-36')}
        >
          {CLIS.map((c) => (
            <option key={c} value={c}>
              {CLI_INFO[c].displayName}
            </option>
          ))}
        </select>
        <ModelPicker
          cli={member.cli}
          value={member.model}
          testId="ensemble-crew-model"
          className="min-w-56 flex-1"
          onChange={(model) => set({ model })}
        />
        {info.efforts.length > 0 && (
          <select
            aria-label="Effort"
            data-testid="ensemble-crew-effort"
            value={member.effort ?? ''}
            onChange={(e) => set({ effort: e.target.value || undefined })}
            className={cn(inputSized, 'w-28')}
          >
            <option value="">default effort</option>
            {info.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** Problems that keep a crew from being saved. */
export function crewProblems(crew: EnsembleCrew): string[] {
  const out: string[] = [];
  const names = new Set<string>();
  for (const m of crew.members) {
    const name = m.name.trim().toLowerCase();
    if (!name) out.push('Every member needs a name.');
    else if (names.has(name)) out.push(`Two members are called ${m.name.trim()}.`);
    names.add(name);
  }
  return [...new Set(out)];
}

/** Sets up the crew once (setting `ensemble.crew`): members, their AI, model and effort, and the lead. */
export function CrewEditor({ crew, onDone }: { crew: EnsembleCrew; onDone: () => void }) {
  const [draft, setDraft] = useState<EnsembleCrew>(() => structuredClone(crew));
  const [saving, setSaving] = useState(false);
  const problems = crewProblems(draft);
  const setMember = (index: number, m: EnsembleAgent) =>
    setDraft((d) => ({ ...d, members: d.members.map((x, i) => (i === index ? m : x)) }));
  const save = async () => {
    setSaving(true);
    try {
      const members = draft.members.map((m) => ({ ...m, name: m.name.trim() }));
      await ipc.invoke('settings:update', { 'ensemble.crew': { ...draft, members } });
      onDone();
    } catch (e) {
      notify('error', 'The crew could not be saved', { description: message(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="ensemble-crew-editor">
      <p className="text-small text-fg-muted">
        Set up your crew once; every “Lead &amp; crew” task uses it. The lead gets the task and decides who does what;
        the others start only when the lead hands them work. Changes apply to new tasks.
      </p>
      {draft.members.map((m, i) => (
        <MemberRow
          key={m.id}
          member={m}
          lead={draft.leadId === m.id}
          onChange={(next) => setMember(i, next)}
          onLead={() => setDraft((d) => ({ ...d, leadId: m.id }))}
          onRemove={
            draft.members.length > 1
              ? () =>
                  setDraft((d) => {
                    const members = d.members.filter((x) => x.id !== m.id);
                    return { ...d, members, leadId: d.leadId === m.id ? members[0]!.id : d.leadId };
                  })
              : undefined
          }
        />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Add a member"
          data-testid="ensemble-crew-add"
          value=""
          disabled={draft.members.length >= 12}
          onChange={(e) => {
            const preset = e.target.value as RolePreset;
            if (!preset) return;
            setDraft((d) => ({ ...d, members: [...d.members, agentFromPreset(preset, d.members)] }));
          }}
          className={cn(inputSized, 'w-44')}
        >
          <option value="">Add a member…</option>
          {ROLE_PRESETS.filter((p) => p.preset !== 'advisor').map((p) => (
            <option key={p.preset} value={p.preset}>
              {p.preset === 'custom' ? 'Custom role' : p.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-small text-fg-secondary">
          Agents at the same time
          <input
            type="number"
            min={1}
            max={8}
            data-testid="ensemble-crew-concurrency"
            value={draft.maxConcurrentAgents}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                maxConcurrentAgents: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))),
              }))
            }
            className={cn(inputSized, 'w-16')}
          />
        </label>
        <span className="flex-1" />
        <Button
          variant="ghost"
          data-testid="ensemble-crew-reset"
          onClick={() => setDraft(defaultCrew())}
          title="The default crew: a lead on Opus and five teammates"
        >
          <RotateCcw size={13} /> Default crew
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="ensemble-crew-save"
          disabled={saving || problems.length > 0}
          onClick={() => void save()}
        >
          {saving && <Loader2 size={14} className="animate-spin" />} Save crew
        </Button>
      </div>
      {problems.length > 0 && <div className="text-small text-warning">{problems.join(' ')}</div>}
    </div>
  );
}

/** Crew members left out of new tasks (remembered between tasks, per computer). */
const OFF_KEY = 'oxytocin.ensemble.crewOff';

function loadOff(): string[] {
  try {
    const raw = localStorage.getItem(OFF_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveOff(off: string[]): void {
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify(off));
  } catch {
    // Unavailable storage: the choice holds for this window only.
  }
}

/**
 * The crew at a glance, the lead first. Members can be left out of this task: the lead is told only about the
 * members that are on (none of them starts before the lead hands it work).
 */
function CrewSummary({
  crew,
  off,
  onToggle,
}: {
  crew: EnsembleCrew;
  off: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const lead = crew.members.find((m) => m.id === crew.leadId);
  const others = crew.members.filter((m) => m.id !== crew.leadId);
  const body = (m: EnsembleAgent, isLead: boolean) => (
    <>
      <AgentAvatar agent={m} size={22} />
      <span className="flex flex-col">
        <span className="flex items-center gap-1 font-medium text-fg">
          {isLead && <Crown size={11} className="text-agent" />}
          {m.name} <span className="font-normal text-fg-muted">· {m.role.label}</span>
        </span>
        <span className="font-mono text-[11px] text-fg-muted">{modelLabel(m)}</span>
      </span>
    </>
  );
  return (
    <div className="flex flex-wrap gap-2" data-testid="ensemble-crew-summary" role="group" aria-label="Crew">
      {lead && (
        <span
          data-testid="ensemble-crew-summary-lead"
          className="flex items-center gap-2 rounded-card border border-line-focus bg-focus-tint px-2.5 py-1.5"
          title={`Leads the task · ${CLI_INFO[lead.cli].displayName} · ${lead.readOnly ? 'read-only' : 'edits files'}`}
        >
          {body(lead, true)}
        </span>
      )}
      {others.map((m) => {
        const on = !off.has(m.id);
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={on}
            data-testid="ensemble-crew-summary-member"
            data-member-id={m.id}
            onClick={() => onToggle(m.id)}
            title={`${on ? 'Available to the lead' : 'Left out of this task'} · ${CLI_INFO[m.cli].displayName} · ${m.readOnly ? 'read-only' : 'edits files'} — click to ${on ? 'leave out' : 'include'}`}
            className={cn(
              'flex items-center gap-2 rounded-card border px-2.5 py-1.5 text-left transition-colors',
              on ? 'border-line bg-card' : 'border-line-subtle bg-card opacity-50 hover:opacity-80',
            )}
          >
            {body(m, false)}
            {on && <Check size={13} className="text-accent" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Lead & crew": describe the task once; the lead of your crew gets it, works out what it needs and hands pieces to
 * the crew — research, code, review, tests — in parallel where it can. The crew (who runs on which model and effort)
 * is set up once and reused.
 */
export function CrewStart({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const setting = useSettingsStore((s) => s.settings?.['ensemble.crew']);
  const crew = crewOf(setting);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [approveResult, setApproveResult] = useState(true);
  const [editing, setEditing] = useState(false);
  const [offList, setOffList] = useState<string[]>(loadOff);
  const off = new Set(offList);
  const toggle = (id: string) => {
    const next = off.has(id) ? offList.filter((x) => x !== id) : [...offList, id];
    setOffList(next);
    saveOff(next);
  };
  const memberIds = crew.members.filter((m) => m.id === crew.leadId || !off.has(m.id)).map((m) => m.id);
  const [busy, setBusy] = useState<'start' | 'customize' | null>(null);
  const [checks, setChecks] = useState<EnsembleChecks | null>(null);
  const clis = [...new Set(crew.members.map((m) => m.cli))].sort().join(',');

  useEffect(() => {
    let alive = true;
    void ipc.invoke('ensemble:checks', { projectId, clis: clis.split(',') as EnsembleCli[] }).then(
      (c) => alive && setChecks(c),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId, clis]);

  const notRepo = checks !== null && !checks.repo.isRepo;
  const writes = crew.members.some((m) => memberIds.includes(m.id) && !m.readOnly);
  const problems = [
    ...(checks?.clis ?? [])
      .filter((c) => !c.installed)
      .map(
        (c) =>
          `${CLI_INFO[c.cli].displayName} was not found (${c.problem ?? 'not on PATH'}): ${CLI_INFO[c.cli].installHint}`,
      ),
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
      const record = await ipc.invoke('ensemble:createCrew', {
        projectId,
        prompt,
        ...(title.trim() ? { title: title.trim() } : {}),
        memberIds,
        ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
        approveResult,
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
    <div className="flex flex-col gap-4" data-testid="ensemble-crew-start">
      <label className="flex flex-col gap-1">
        <span className="text-small font-medium text-fg-secondary">What should the crew do?</span>
        <textarea
          data-testid="ensemble-crew-prompt"
          value={prompt}
          rows={7}
          autoFocus
          placeholder={
            'Describe the task like you would to a lead engineer: what to build, where, constraints, acceptance criteria.\nThe lead decides who researches, who codes, who reviews and who tests.'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create(true);
          }}
          className="resize-y rounded-control border border-line bg-input p-2 text-ui text-fg placeholder:text-fg-muted"
        />
      </label>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-fg-muted" />
          <span className="text-small font-medium text-fg-secondary">Your crew</span>
          <span className="text-small text-fg-muted">
            — the lead may hand work to the members that are on; each starts only when it gets some
          </span>
          <span className="flex-1" />
          {!editing && (
            <Button variant="ghost" size="sm" data-testid="ensemble-crew-setup" onClick={() => setEditing(true)}>
              <Settings2 size={12} /> Set up crew
            </Button>
          )}
        </div>
        {editing ? (
          <CrewEditor crew={crew} onDone={() => setEditing(false)} />
        ) : (
          <CrewSummary crew={crew} off={off} onToggle={toggle} />
        )}
      </section>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            data-testid="ensemble-crew-approve"
            checked={approveResult}
            onChange={(e) => setApproveResult(e.target.checked)}
          />
          I approve the result at the end
        </label>
        <label className="flex items-center gap-2 text-fg-secondary">
          Test command
          <input
            data-testid="ensemble-crew-test-command"
            value={testCommand}
            placeholder="optional, e.g. npm test"
            onChange={(e) => setTestCommand(e.target.value)}
            className={cn(inputSized, 'w-44 font-mono')}
          />
        </label>
        <label className="flex items-center gap-2 text-fg-secondary">
          Title
          <input
            data-testid="ensemble-crew-title"
            value={title}
            maxLength={120}
            placeholder={titleFromPrompt(prompt) || 'from the prompt'}
            onChange={(e) => setTitle(e.target.value)}
            className={cn(inputSized, 'w-64')}
          />
        </label>
      </div>

      {(problems.length > 0 || (notRepo && writes)) && (
        <div className="flex flex-col gap-0.5 text-small text-warning" data-testid="ensemble-crew-problems">
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
          “Customize first” opens the task in the builder (prompts per role, stages).
        </span>
        <Button
          data-testid="ensemble-crew-customize"
          disabled={!prompt.trim() || busy !== null || editing}
          onClick={() => void create(false)}
        >
          {busy === 'customize' ? <Loader2 size={14} className="animate-spin" /> : <Settings2 size={14} />} Customize
          first
        </Button>
        <Button
          variant="primary"
          data-testid="ensemble-crew-go"
          disabled={!prompt.trim() || busy !== null || editing}
          onClick={() => void create(true)}
          title="Ctrl+Enter"
        >
          {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start
        </Button>
      </div>
    </div>
  );
}
