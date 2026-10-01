import { DropdownMenu } from 'radix-ui';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Repeat,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AdvisorMoment,
  type EnsembleAgent,
  type EnsembleChecks,
  type EnsembleCli,
  type EnsembleRecord,
  type EnsembleTask,
  type GateShow,
  isActiveStatus,
  OUTPUT_LABELS,
  type OutputKind,
  ROLE_COLORS,
  type RolePreset,
  type Stage,
} from '@shared/domain/ensemble';
import { CLI_INFO, PERMISSION_LABELS } from '@shared/ensemble/clis';
import { MOMENT_LABELS, type TaskProblem, usedAgentIds, validateTask } from '@shared/ensemble/conductor';
import { agentFromPreset, newStage, ROLE_PRESETS, rolePreset, slugId } from '@shared/ensemble/presets';
import { assignmentMessage, systemPromptText, TEMPLATE_VARIABLES } from '@shared/ensemble/prompts';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Kbd } from '../../ui/Kbd';
import { Check, Field, input, Segmented } from '../projects/settings/controls';
import { saveTask, useEnsembleStore } from './ensemble-store';
import { AgentAvatar, roleColor, inputSized } from './ui';

const menuContent = 'z-50 min-w-56 max-w-96 rounded-control border border-line bg-elevated p-1 shadow-lg';
const menuItem =
  'flex cursor-default items-center gap-2 rounded-badge px-2 py-1.5 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';
const textarea =
  'w-full resize-y rounded-control border border-line bg-input p-2 font-mono text-ui text-fg placeholder:text-fg-muted';

const OUTPUTS: OutputKind[] = ['plan', 'implementation', 'review', 'test-report', 'research', 'free'];
const MOMENTS: AdvisorMoment[] = ['before-plan', 'repeated-error', 'before-gate', 'before-done'];
const GATE_SHOWS: { value: GateShow; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'diff', label: 'Changes' },
  { value: 'review', label: 'Reviews' },
  { value: 'tests', label: 'Tests' },
  { value: 'summary', label: 'Latest result' },
];
const CLIS: EnsembleCli[] = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'custom'];

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function Card({
  title,
  icon,
  children,
  action,
  testId,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line-subtle bg-card p-4" data-testid={testId}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-fg-muted">{icon}</span>}
        <h3 className="oxy-label flex-1">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 self-start text-small text-fg-secondary hover:text-fg"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {label}
      </button>
      {open && children}
    </div>
  );
}

function AgentSelect({
  agents,
  value,
  onChange,
  empty,
  testId,
}: {
  agents: EnsembleAgent[];
  value: string | undefined;
  onChange: (id: string) => void;
  empty?: string;
  testId?: string;
}) {
  return (
    <select data-testid={testId} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={input}>
      {(empty !== undefined || !agents.some((a) => a.id === value)) && (
        <option value="">{empty ?? 'Choose an agent'}</option>
      )}
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {a.role.label}
        </option>
      ))}
    </select>
  );
}

// ── team ────────────────────────────────────────────────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  task,
  checks,
  problems,
  onChange,
  onRemove,
  onDuplicate,
  selected,
  onSelect,
}: {
  agent: EnsembleAgent;
  task: EnsembleTask;
  checks: EnsembleChecks | null;
  problems: TaskProblem[];
  onChange: (a: EnsembleAgent) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const info = CLI_INFO[agent.cli];
  const status = checks?.clis.find((c) => c.cli === agent.cli);
  const set = (patch: Partial<EnsembleAgent>) => onChange({ ...agent, ...patch });
  const isAdvisor = task.advisor?.agentId === agent.id;
  const used = usedAgentIds(task).has(agent.id);
  const listId = `ens-models-${agent.id}`;
  return (
    <div
      data-testid="ensemble-agent-card"
      data-agent-id={agent.id}
      onFocus={onSelect}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-2.5 rounded-card border bg-surface p-3 transition-colors',
        selected ? 'border-line-focus' : 'border-line-subtle',
      )}
    >
      <div className="flex items-center gap-2">
        <AgentAvatar agent={agent} size={28} />
        <div className="flex min-w-0 flex-1 flex-col">
          <input
            aria-label="Agent name"
            data-testid="ensemble-agent-name"
            value={agent.name}
            maxLength={40}
            onChange={(e) => set({ name: e.target.value })}
            className="h-6 min-w-0 rounded-badge border border-transparent bg-transparent px-1 font-medium text-fg hover:border-line focus:border-line-focus"
          />
          <div className="flex items-center gap-1 px-1 text-small text-fg-muted">
            {isAdvisor ? (
              <span className="text-agent">advisor on call</span>
            ) : used ? (
              'in the pipeline'
            ) : (
              'not in the pipeline yet'
            )}
          </div>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label="Agent menu" icon={<MoreHorizontal size={14} />} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className={menuContent}>
              <DropdownMenu.Item className={menuItem} onSelect={onDuplicate}>
                <Copy size={13} /> Duplicate
              </DropdownMenu.Item>
              <DropdownMenu.Item className={menuItem} data-testid="ensemble-agent-remove" onSelect={onRemove}>
                <Trash2 size={13} className="text-danger" /> Remove
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Role">
          <input
            data-testid="ensemble-agent-role"
            value={agent.role.label}
            maxLength={40}
            onChange={(e) => set({ role: { ...agent.role, label: e.target.value } })}
            className={input}
          />
        </Field>
        <Field label="Color">
          <div className="flex h-7 items-center gap-1" role="radiogroup" aria-label="Role color">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={agent.role.color === c}
                aria-label={c}
                onClick={() => set({ role: { ...agent.role, color: c } })}
                className={cn(
                  'size-3.5 rounded-full',
                  agent.role.color === c && 'ring-2 ring-line-focus ring-offset-1 ring-offset-surface',
                )}
                style={{ background: roleColor(c) }}
              />
            ))}
          </div>
        </Field>
      </div>
      <Field
        label="AI (CLI)"
        hint={
          status && !status.installed ? (
            <span className="text-warning" data-testid="ensemble-cli-missing">
              {status.problem ?? 'Not found'} — {info.installHint}
            </span>
          ) : status?.version ? (
            <span>{status.version}</span>
          ) : undefined
        }
      >
        <select
          data-testid="ensemble-agent-cli"
          value={agent.cli}
          onChange={(e) => {
            const cli = e.target.value as EnsembleCli;
            const next = CLI_INFO[cli];
            set({
              cli,
              model: next.models.some((m) => m.id === agent.model) ? agent.model : undefined,
              effort: next.efforts.includes(agent.effort ?? '') ? agent.effort : undefined,
              permissionMode: next.permissionModes.includes(agent.permissionMode) ? agent.permissionMode : 'default',
            });
          }}
          className={input}
        >
          {CLIS.map((c) => {
            const s = checks?.clis.find((x) => x.cli === c);
            return (
              <option key={c} value={c}>
                {CLI_INFO[c].displayName}
                {s && !s.installed ? ' (not found)' : ''}
              </option>
            );
          })}
        </select>
      </Field>
      {agent.cli === 'custom' && (
        <Field label="Command" hint={CLI_INFO.custom.installHint}>
          <input
            value={agent.customCommand ?? ''}
            placeholder="aider --model {{model}}"
            onChange={(e) => set({ customCommand: e.target.value })}
            className={cn(input, 'font-mono')}
          />
        </Field>
      )}
      {agent.cli !== 'custom' && (
        <Field label="Model" hint={agent.model ? undefined : "Empty: the CLI's default model"}>
          <input
            data-testid="ensemble-agent-model"
            list={listId}
            value={agent.model ?? ''}
            placeholder="default"
            onChange={(e) => set({ model: e.target.value || undefined })}
            className={cn(input, 'font-mono')}
          />
          <datalist id={listId}>
            {info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.hint ? ` — ${m.hint}` : ''}
              </option>
            ))}
          </datalist>
        </Field>
      )}
      {info.efforts.length > 0 && (
        <Field label="Effort">
          <Segmented
            label="Effort"
            testId="ensemble-agent-effort"
            value={agent.effort ?? ''}
            options={[{ value: '', label: 'default' }, ...info.efforts.map((e) => ({ value: e, label: e }))]}
            onChange={(v) => set({ effort: v || undefined })}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 items-end gap-2">
        <Field label="Permissions">
          <select
            value={agent.permissionMode}
            onChange={(e) => set({ permissionMode: e.target.value as EnsembleAgent['permissionMode'] })}
            className={input}
          >
            {info.permissionModes.map((m) => (
              <option key={m} value={m}>
                {PERMISSION_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <div className="h-7 pb-1">
          <Check
            checked={agent.readOnly}
            testId="ensemble-agent-readonly"
            onChange={(v) => set({ readOnly: v })}
            disabled={isAdvisor}
          >
            Read-only
          </Check>
        </div>
      </div>
      <Disclosure label="Role prompt" defaultOpen={!agent.rolePrompt}>
        <textarea
          data-testid="ensemble-agent-prompt"
          value={agent.rolePrompt}
          rows={4}
          placeholder="What this agent focuses on, how it works…"
          onChange={(e) => set({ rolePrompt: e.target.value })}
          className={textarea}
        />
        <div className="flex gap-1">
          <select
            aria-label="Role preset"
            value=""
            onChange={(e) => {
              const p = rolePreset(e.target.value as RolePreset);
              set({ rolePrompt: p.rolePrompt, role: { ...agent.role, preset: p.preset } });
            }}
            className={cn(inputSized, 'w-auto text-small')}
          >
            <option value="">Use preset text…</option>
            {ROLE_PRESETS.filter((p) => p.rolePrompt).map((p) => (
              <option key={p.preset} value={p.preset}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </Disclosure>
      <Disclosure label="Advanced">
        <Field label="Extra arguments (one per line)" hint="Passed to the CLI as they are.">
          <textarea
            value={agent.extraArgs.join('\n')}
            rows={2}
            onChange={(e) => set({ extraArgs: lines(e.target.value) })}
            className={textarea}
          />
        </Field>
        <Field label="Environment (NAME=value per line)" hint="Only for this agent's terminal. No secrets.">
          <textarea
            value={Object.entries(agent.env)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')}
            rows={2}
            onChange={(e) =>
              set({
                env: Object.fromEntries(
                  lines(e.target.value)
                    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)] as const)
                    .filter(([k]) => k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)),
                ),
              })
            }
            className={textarea}
          />
        </Field>
      </Disclosure>
      {problems.map((p, i) => (
        <div key={i} className="text-small text-danger">
          {p.message}
        </div>
      ))}
    </div>
  );
}

function AddAgentMenu({ onAdd }: { onAdd: (preset: RolePreset) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" data-testid="ensemble-add-agent">
          <Plus size={12} /> Add agent
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuContent} data-testid="ensemble-add-agent-menu">
          {ROLE_PRESETS.map((p) => (
            <DropdownMenu.Item
              key={p.preset}
              className={menuItem}
              data-testid={`ensemble-add-agent-${p.preset}`}
              onSelect={() => onAdd(p.preset)}
            >
              <span className="size-2.5 flex-none rounded-full" style={{ background: roleColor(p.color) }} />
              <span className="flex min-w-0 flex-col">
                <span>
                  {p.label}
                  <span className="ml-1 text-fg-muted">
                    — {CLI_INFO[p.cli].displayName}
                    {p.model ? ` · ${p.model}` : ''}
                    {p.effort ? ` · ${p.effort}` : ''}
                  </span>
                </span>
                <span className="text-small text-fg-muted">{p.hint}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── pipeline ────────────────────────────────────────────────────────────────────────────────────────────────────

const STAGE_ICONS: Record<Stage['kind'], ReactNode> = {
  agent: <Bot size={13} />,
  parallel: <Users size={13} />,
  loop: <Repeat size={13} />,
  gate: <ShieldCheck size={13} />,
  command: <SquareTerminal size={13} />,
};
const STAGE_KIND_LABELS: Record<Stage['kind'], string> = {
  agent: 'Agent step',
  parallel: 'Parallel',
  loop: 'Implement ⇄ Review loop',
  gate: 'Approval gate',
  command: 'Command',
};

function stageSummary(stage: Stage, task: EnsembleTask): string {
  const name = (id: string | undefined) => task.agents.find((a) => a.id === id)?.name ?? '—';
  switch (stage.kind) {
    case 'agent':
      return `${name(stage.agentId)} · ${OUTPUT_LABELS[stage.output]}`;
    case 'parallel':
      return `${stage.agentIds.map(name).join(', ')} · ${stage.join === 'first' ? 'first wins' : 'all'}`;
    case 'loop':
      return `${name(stage.workerId)} ⇄ ${name(stage.checkerId)} · max ${stage.maxRounds}`;
    case 'gate':
      return 'your approval';
    case 'command':
      return stage.command;
  }
}

function StageLane({
  task,
  selected,
  onSelect,
  onMove,
  problems,
}: {
  task: EnsembleTask;
  selected: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
  problems: TaskProblem[];
}) {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1" data-testid="ensemble-stage-lane">
      {task.pipeline.length === 0 && (
        <div className="py-3 text-small text-fg-muted">No stages yet: add the first one.</div>
      )}
      {task.pipeline.map((stage, i) => {
        const bad = problems.some((p) => p.where === `stage:${stage.id}`);
        return (
          <div key={stage.id} className="flex flex-none items-center gap-1">
            {i > 0 && <ArrowRight size={13} className="flex-none text-fg-muted" aria-hidden />}
            <button
              type="button"
              data-testid="ensemble-stage-card"
              data-stage-id={stage.id}
              aria-pressed={selected === stage.id}
              onClick={() => onSelect(stage.id)}
              onKeyDown={(e) => {
                if (e.altKey && e.key === 'ArrowLeft') onMove(stage.id, -1);
                if (e.altKey && e.key === 'ArrowRight') onMove(stage.id, 1);
              }}
              className={cn(
                'flex w-44 flex-col gap-1 rounded-control border px-2.5 py-2 text-left transition-colors',
                selected === stage.id
                  ? 'border-line-focus bg-focus-tint'
                  : 'border-line-subtle bg-surface hover:bg-card-hover',
                bad && 'border-danger/60',
              )}
            >
              <span className="flex items-center gap-1.5 text-fg">
                <span className="text-fg-muted">{STAGE_ICONS[stage.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{stage.title}</span>
              </span>
              <span className="truncate text-small text-fg-muted">{stageSummary(stage, task)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function VariableChips({ onInsert }: { onInsert: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {TEMPLATE_VARIABLES.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{{${v}}}`)}
          className="rounded-badge border border-line-subtle px-1 font-mono text-[10px] text-fg-secondary hover:border-line hover:text-fg"
        >
          {`{{${v}}}`}
        </button>
      ))}
    </div>
  );
}

function InstructionEditor({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = ref.current;
    if (!el) return onChange(value + text);
    const start = el.selectionStart;
    const next = value.slice(0, start) + text + value.slice(el.selectionEnd);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        data-testid={testId}
        value={value}
        rows={4}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={textarea}
      />
      <VariableChips onInsert={insert} />
    </div>
  );
}

function StageEditor({
  stage,
  task,
  onChange,
  onRemove,
  onMove,
  problems,
}: {
  stage: Stage;
  task: EnsembleTask;
  onChange: (s: Stage) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
  problems: TaskProblem[];
}) {
  const set = (patch: Partial<Stage>) => onChange({ ...stage, ...patch } as Stage);
  const workers = task.agents.filter((a) => a.id !== task.advisor?.agentId);
  return (
    <div
      className="flex flex-col gap-3 rounded-control border border-line-subtle bg-surface p-3"
      data-testid="ensemble-stage-editor"
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-muted">{STAGE_ICONS[stage.kind]}</span>
        <span className="oxy-label">{STAGE_KIND_LABELS[stage.kind]}</span>
        <span className="flex-1" />
        <IconButton label="Move left (Alt+←)" icon={<ArrowLeft size={13} />} onClick={() => onMove(-1)} />
        <IconButton label="Move right (Alt+→)" icon={<ArrowRight size={13} />} onClick={() => onMove(1)} />
        <IconButton
          label="Remove stage"
          data-testid="ensemble-stage-remove"
          icon={<Trash2 size={13} />}
          onClick={onRemove}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Title">
          <input
            data-testid="ensemble-stage-title"
            value={stage.title}
            maxLength={60}
            onChange={(e) => set({ title: e.target.value })}
            className={input}
          />
        </Field>
        {stage.kind === 'agent' && (
          <Field label="Agent">
            <AgentSelect
              testId="ensemble-stage-agent"
              agents={workers}
              value={stage.agentId}
              onChange={(agentId) => set({ agentId })}
            />
          </Field>
        )}
        {(stage.kind === 'agent' || stage.kind === 'parallel') && (
          <Field label="Result">
            <select
              data-testid="ensemble-stage-output"
              value={stage.output}
              onChange={(e) => set({ output: e.target.value as OutputKind })}
              className={input}
            >
              {OUTPUTS.map((o) => (
                <option key={o} value={o}>
                  {OUTPUT_LABELS[o]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {stage.kind === 'loop' && (
          <>
            <Field label="Worker">
              <AgentSelect agents={workers} value={stage.workerId} onChange={(workerId) => set({ workerId })} />
            </Field>
            <Field label="Reviewer">
              <AgentSelect agents={workers} value={stage.checkerId} onChange={(checkerId) => set({ checkerId })} />
            </Field>
            <Field label="Max rounds">
              <input
                type="number"
                min={1}
                max={10}
                value={stage.maxRounds}
                onChange={(e) => set({ maxRounds: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
                className={input}
              />
            </Field>
          </>
        )}
        {stage.kind === 'command' && (
          <>
            <Field label="Command (runs in the working folder)">
              <input
                data-testid="ensemble-stage-command"
                value={stage.command}
                onChange={(e) => set({ command: e.target.value })}
                className={cn(input, 'font-mono')}
              />
            </Field>
            <Field label="On failure, send the output to">
              <AgentSelect
                agents={workers}
                value={stage.onFail.agentId}
                empty="nobody (ask me)"
                onChange={(agentId) =>
                  set({ onFail: { maxAttempts: stage.onFail.maxAttempts, ...(agentId ? { agentId } : {}) } })
                }
              />
            </Field>
            <Field label="Fix attempts">
              <input
                type="number"
                min={0}
                max={5}
                value={stage.onFail.maxAttempts}
                onChange={(e) =>
                  set({
                    onFail: { ...stage.onFail, maxAttempts: Math.max(0, Math.min(5, Number(e.target.value) || 0)) },
                  })
                }
                className={input}
              />
            </Field>
          </>
        )}
        {stage.kind === 'gate' && (
          <Field label="When you reject">
            <select
              value={stage.onReject}
              onChange={(e) => set({ onReject: e.target.value as 'back-to-previous' | 'stop' })}
              className={input}
            >
              <option value="back-to-previous">Send my comments back to the previous stage</option>
              <option value="stop">Stop the task</option>
            </select>
          </Field>
        )}
      </div>
      {stage.kind === 'parallel' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg-secondary">Agents (read-only: they share one folder)</span>
          <div className="flex flex-wrap gap-3">
            {workers.map((a) => (
              <Check
                key={a.id}
                checked={stage.agentIds.includes(a.id)}
                onChange={(v) =>
                  set({ agentIds: v ? [...stage.agentIds, a.id] : stage.agentIds.filter((id) => id !== a.id) })
                }
              >
                {a.name}
                {a.readOnly ? '' : ' (writes)'}
              </Check>
            ))}
          </div>
          <Segmented
            label="Join"
            value={stage.join}
            options={[
              { value: 'all', label: 'Wait for all' },
              { value: 'first', label: 'First result wins' },
            ]}
            onChange={(join) => set({ join })}
          />
        </div>
      )}
      {stage.kind === 'gate' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg-secondary">Show at the gate</span>
          <div className="flex flex-wrap gap-3">
            {GATE_SHOWS.map((g) => (
              <Check
                key={g.value}
                checked={stage.show.includes(g.value)}
                onChange={(v) => set({ show: v ? [...stage.show, g.value] : stage.show.filter((x) => x !== g.value) })}
              >
                {g.label}
              </Check>
            ))}
          </div>
        </div>
      )}
      {stage.kind !== 'gate' && stage.kind !== 'command' && (
        <Field
          label={stage.kind === 'loop' ? "Worker's instruction" : 'Instruction'}
          hint="Empty: a good default for the result kind."
        >
          <InstructionEditor
            testId="ensemble-stage-instruction"
            value={stage.instruction}
            onChange={(instruction) => set({ instruction })}
            placeholder="What the agent should do in this stage. Variables are filled in when it runs."
          />
        </Field>
      )}
      {stage.kind === 'loop' && (
        <Field label="Reviewer's instruction" hint="Empty: review the diff against the base and report findings.">
          <InstructionEditor
            value={stage.checkerInstruction}
            onChange={(checkerInstruction) => set({ checkerInstruction })}
            placeholder="How to review"
          />
        </Field>
      )}
      {problems.map((p, i) => (
        <div key={i} className="text-small text-danger">
          {p.message}
        </div>
      ))}
    </div>
  );
}

// ── checks and preview ──────────────────────────────────────────────────────────────────────────────────────────

function CheckRow({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 text-small">
      {ok ? (
        <CheckCircle2 size={13} className="mt-px flex-none text-success" />
      ) : (
        <XCircle size={13} className={cn('mt-px flex-none', warn ? 'text-warning' : 'text-danger')} />
      )}
      <span className="min-w-0 text-fg-secondary">{children}</span>
    </div>
  );
}

function Checks({ checks, task }: { checks: EnsembleChecks | null; task: EnsembleTask }) {
  if (!checks)
    return (
      <div className="flex items-center gap-1.5 text-small text-fg-muted">
        <Loader2 size={12} className="animate-spin" /> Checking…
      </div>
    );
  const usesClaude = task.agents.some((a) => a.cli === 'claude-code');
  return (
    <div className="flex flex-col gap-1.5" data-testid="ensemble-checks">
      {checks.clis.map((c) => (
        <CheckRow key={c.cli} ok={c.installed}>
          {CLI_INFO[c.cli].displayName} {c.installed ? (c.version ?? 'found') : `not found (${c.command})`}
        </CheckRow>
      ))}
      <CheckRow ok={checks.mcp.running}>
        {checks.mcp.running
          ? "Oxytocin's MCP server is running"
          : checks.mcp.enabled
            ? `The MCP server is not running${checks.mcp.error ? `: ${checks.mcp.error}` : ''}`
            : 'Turn on the MCP server (Settings → mcp.enabled)'}
      </CheckRow>
      {usesClaude && (
        <CheckRow ok={checks.bridge} warn>
          {checks.bridge
            ? 'Claude Code Bridge on: exact agent states'
            : 'Claude Code Bridge off: states come from the session registry'}
        </CheckRow>
      )}
      <CheckRow
        ok={checks.repo.isRepo || task.workspace.mode === 'current-checkout'}
        warn={task.workspace.mode === 'current-checkout'}
      >
        {checks.repo.isRepo
          ? `git: ${checks.repo.branch ?? 'detached'}${checks.repo.dirty ? `, ${checks.repo.dirty} uncommitted change${checks.repo.dirty === 1 ? '' : 's'} (not in the worktree)` : ', clean'}`
          : 'Not a git repository: only "Current checkout" works'}
      </CheckRow>
    </div>
  );
}

function PromptPreview({
  task,
  agentId,
  onAgent,
}: {
  task: EnsembleTask;
  agentId: string | null;
  onAgent: (id: string) => void;
}) {
  const agent = task.agents.find((a) => a.id === agentId) ?? task.agents[0];
  if (!agent) return <p className="text-small text-fg-muted">Add an agent to see what it receives.</p>;
  const stage = task.pipeline.find((s) =>
    s.kind === 'agent'
      ? s.agentId === agent.id
      : s.kind === 'parallel'
        ? s.agentIds.includes(agent.id)
        : s.kind === 'loop'
          ? s.workerId === agent.id || s.checkerId === agent.id
          : false,
  );
  const message = stage
    ? assignmentMessage({
        agent,
        stage,
        output:
          stage.kind === 'loop'
            ? stage.checkerId === agent.id
              ? 'review'
              : 'implementation'
            : stage.kind === 'agent' || stage.kind === 'parallel'
              ? stage.output
              : 'free',
        round: stage.kind === 'loop' ? 1 : undefined,
        maxRounds: stage.kind === 'loop' ? stage.maxRounds : undefined,
      })
    : null;
  const system = systemPromptText(task, agent, { path: '<worktree>', branch: 'ensemble/…' });
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="ensemble-prompt-preview">
      <select aria-label="Agent" value={agent.id} onChange={(e) => onAgent(e.target.value)} className={input}>
        {task.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.role.label}
          </option>
        ))}
      </select>
      <div className="text-small text-fg-muted">
        {CLI_INFO[agent.cli].systemPromptFile
          ? 'System prompt file (once per session):'
          : 'Served by oxy_ensemble_context (this CLI reads no prompt file):'}
      </div>
      <pre className="max-h-72 overflow-auto rounded-control border border-line-subtle bg-input p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-secondary select-text">
        {system}
      </pre>
      {message && (
        <>
          <div className="text-small text-fg-muted">First message typed into its terminal:</div>
          <pre className="overflow-auto rounded-control border border-line-subtle bg-input p-2 font-mono text-[11px] whitespace-pre-wrap text-fg select-text">
            {message}
          </pre>
        </>
      )}
    </div>
  );
}

// ── the builder ─────────────────────────────────────────────────────────────────────────────────────────────────

export function Builder({ record, onStart }: { record: EnsembleRecord; onStart: () => void }) {
  const draft = useEnsembleStore((s) => s.drafts[record.task.id]);
  const task = draft ?? record.task;
  const locked = isActiveStatus(record.run.status);
  const [selectedStage, setSelectedStage] = useState<string | null>(task.pipeline[0]?.id ?? null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(task.agents[0]?.id ?? null);
  const [checks, setChecks] = useState<EnsembleChecks | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saved'>('idle');
  const problems = useMemo(() => validateTask(task), [task]);

  const update = (patch: Partial<EnsembleTask>) => {
    if (locked) return;
    useEnsembleStore.getState().setDraft({ ...task, ...patch }, task.id);
  };

  // Drafts save themselves shortly after the last edit.
  useEffect(() => {
    if (!draft || locked) return;
    const t = setTimeout(() => void saveTask(draft).then((r) => setSaving(r ? 'saved' : 'idle')), 700);
    return () => clearTimeout(t);
  }, [draft, locked]);
  const saveState = draft && !locked ? 'saving' : saving;

  const cliKey = [...new Set(task.agents.map((a) => a.cli))].sort().join(',');
  useEffect(() => {
    let alive = true;
    void ipc
      .invoke('ensemble:checks', {
        projectId: task.projectId,
        clis: cliKey ? (cliKey.split(',') as EnsembleCli[]) : [],
      })
      .then(
        (c) => alive && setChecks(c),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [task.projectId, cliKey]);

  const setAgent = (id: string, next: EnsembleAgent) =>
    update({ agents: task.agents.map((a) => (a.id === id ? next : a)) });
  const addAgent = (preset: RolePreset) => {
    const agent = agentFromPreset(preset, task.agents);
    const patch: Partial<EnsembleTask> = { agents: [...task.agents, agent] };
    if (preset === 'advisor' && !task.advisor)
      patch.advisor = {
        agentId: agent.id,
        moments: ['before-plan', 'repeated-error', 'before-done'],
        maxInterventions: 5,
      };
    update(patch);
    setSelectedAgent(agent.id);
  };
  const removeAgent = (id: string) => {
    const patch: Partial<EnsembleTask> = { agents: task.agents.filter((a) => a.id !== id) };
    if (task.advisor?.agentId === id) patch.advisor = undefined;
    update(patch);
  };
  const duplicateAgent = (agent: EnsembleAgent) => {
    const names = new Set(task.agents.map((a) => a.name.toLowerCase()));
    let name = `${agent.name} 2`;
    for (let i = 3; names.has(name.toLowerCase()); i++) name = `${agent.name} ${i}`;
    const copy = {
      ...structuredClone(agent),
      name,
      id: slugId(
        name,
        task.agents.map((a) => a.id),
        'agent',
      ),
    };
    update({ agents: [...task.agents, copy] });
  };
  const setStage = (id: string, next: Stage) =>
    update({ pipeline: task.pipeline.map((s) => (s.id === id ? next : s)) });
  const moveStage = (id: string, by: -1 | 1) => {
    const i = task.pipeline.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= task.pipeline.length) return;
    const next = [...task.pipeline];
    [next[i], next[j]] = [next[j]!, next[i]!];
    update({ pipeline: next });
  };
  const addStage = (kind: Stage['kind']) => {
    const stage = newStage(kind, task);
    update({ pipeline: [...task.pipeline, stage] });
    setSelectedStage(stage.id);
  };
  const stage = task.pipeline.find((s) => s.id === selectedStage);
  const ofWhere = (where: string) => problems.filter((p) => p.where === where);
  const advisorAgent = task.advisor ? task.agents.find((a) => a.id === task.advisor!.agentId) : undefined;

  return (
    <div
      className="flex h-full min-h-0"
      data-testid="ensemble-builder"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && record.run.status === 'draft') {
          e.preventDefault();
          onStart();
        }
      }}
    >
      <fieldset disabled={locked} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
          {locked && (
            <div className="rounded-control border border-line-subtle bg-card px-3 py-2 text-small text-fg-secondary">
              The task is running: its team and pipeline are fixed until it ends.
            </div>
          )}
          <Card title="Brief" testId="ensemble-brief">
            <Field label="Title">
              <input
                data-testid="ensemble-title"
                value={task.title}
                maxLength={120}
                onChange={(e) => update({ title: e.target.value })}
                className={input}
              />
            </Field>
            <Field
              label="Description (Markdown)"
              hint="What to build, constraints, acceptance criteria. Every agent reads it."
            >
              <textarea
                data-testid="ensemble-description"
                value={task.description}
                rows={6}
                onChange={(e) => update({ description: e.target.value })}
                className={textarea}
              />
            </Field>
            <Disclosure label="General prompt for the whole team" defaultOpen={!!task.generalPrompt}>
              <textarea
                data-testid="ensemble-general-prompt"
                value={task.generalPrompt}
                rows={3}
                placeholder="e.g. Use TypeScript strict mode. Follow docs/CONVENTIONS.md. Keep commits small."
                onChange={(e) => update({ generalPrompt: e.target.value })}
                className={textarea}
              />
            </Disclosure>
            <Disclosure label="Files the agents should read first" defaultOpen={task.attachments.length > 0}>
              <textarea
                value={task.attachments.map((a) => a.path).join('\n')}
                rows={2}
                placeholder="docs/spec.md (one path per line)"
                onChange={(e) => update({ attachments: lines(e.target.value).map((path) => ({ path })) })}
                className={textarea}
              />
            </Disclosure>
          </Card>

          <Card title="Workspace" icon={<GitBranch size={13} />} testId="ensemble-workspace">
            <Segmented
              label="Workspace"
              testId="ensemble-workspace-mode"
              value={task.workspace.mode}
              options={[
                { value: 'worktree', label: 'Own worktree (recommended)' },
                { value: 'current-checkout', label: 'Current checkout', tone: 'warning' },
              ]}
              onChange={(mode) => update({ workspace: { ...task.workspace, mode } })}
            />
            <p className="text-small text-fg-muted">
              {task.workspace.mode === 'worktree'
                ? 'A git worktree on a new branch, next to the repository: your checkout is never touched. Oxytocin commits a checkpoint after every stage; at the end you merge, squash, keep or discard the branch.'
                : 'Agents work directly in your checkout: only for small sequential tasks, or for read-only teams (reviews).'}
            </p>
            {task.workspace.mode === 'worktree' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Base branch">
                    <input
                      value={task.workspace.baseRef ?? ''}
                      placeholder={checks?.repo.branch ?? 'current branch'}
                      onChange={(e) =>
                        update({
                          workspace: {
                            ...task.workspace,
                            baseRef: e.target.value || undefined,
                          },
                        })
                      }
                      className={cn(input, 'font-mono')}
                    />
                  </Field>
                  <Field label="New branch">
                    <input
                      value={task.workspace.branch ?? ''}
                      placeholder={`ensemble/${slugId(task.title, [], 'task').slice(0, 24)}`}
                      onChange={(e) =>
                        update({
                          workspace: {
                            ...task.workspace,
                            branch: e.target.value || undefined,
                          },
                        })
                      }
                      className={cn(input, 'font-mono')}
                    />
                  </Field>
                </div>
                <Field label="Setup commands (one per line, run before the agents start)">
                  <textarea
                    value={task.workspace.setupCommands.join('\n')}
                    rows={2}
                    placeholder="npm ci"
                    onChange={(e) => update({ workspace: { ...task.workspace, setupCommands: lines(e.target.value) } })}
                    className={textarea}
                  />
                </Field>
                <Field label="Untracked files to copy into the worktree (one per line)">
                  <textarea
                    value={task.workspace.copyFiles.join('\n')}
                    rows={2}
                    placeholder=".env"
                    onChange={(e) => update({ workspace: { ...task.workspace, copyFiles: lines(e.target.value) } })}
                    className={textarea}
                  />
                </Field>
                {checks && checks.untracked.filter((f) => !task.workspace.copyFiles.includes(f)).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-small text-fg-muted">
                    Found:
                    {checks.untracked
                      .filter((f) => !task.workspace.copyFiles.includes(f))
                      .map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() =>
                            update({ workspace: { ...task.workspace, copyFiles: [...task.workspace.copyFiles, f] } })
                          }
                          className="rounded-badge border border-line-subtle px-1.5 font-mono hover:border-line hover:text-fg"
                        >
                          + {f}
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </Card>

          <Card
            title={`Team (${task.agents.length})`}
            icon={<Users size={13} />}
            testId="ensemble-team"
            action={<AddAgentMenu onAdd={addAgent} />}
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {task.agents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  task={task}
                  checks={checks}
                  problems={ofWhere(`agent:${a.id}`)}
                  selected={selectedAgent === a.id}
                  onSelect={() => setSelectedAgent(a.id)}
                  onChange={(next) => setAgent(a.id, next)}
                  onRemove={() => removeAgent(a.id)}
                  onDuplicate={() => duplicateAgent(a)}
                />
              ))}
            </div>
            <div
              className="flex flex-col gap-2 rounded-control border border-dashed border-line px-3 py-2.5"
              data-testid="ensemble-advisor"
            >
              <Check
                checked={!!task.advisor}
                testId="ensemble-advisor-toggle"
                onChange={(on) => {
                  if (!on) return update({ advisor: undefined });
                  let agents = task.agents;
                  let advisor = agents.find((a) => a.role.preset === 'advisor');
                  if (!advisor) {
                    advisor = agentFromPreset('advisor', agents);
                    agents = [...agents, advisor];
                  }
                  update({
                    agents: agents.map((a) => (a.id === advisor.id ? { ...a, readOnly: true } : a)),
                    advisor: {
                      agentId: advisor.id,
                      moments: ['before-plan', 'repeated-error', 'before-done'],
                      maxInterventions: 5,
                    },
                  });
                }}
              >
                Advisor on call — a strong model consulted at a few moments; it never writes code
              </Check>
              {task.advisor && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-5">
                  <div className="w-52">
                    <AgentSelect
                      agents={task.agents}
                      value={task.advisor.agentId}
                      onChange={(agentId) =>
                        update({
                          advisor: { ...task.advisor!, agentId },
                          agents: task.agents.map((a) => (a.id === agentId ? { ...a, readOnly: true } : a)),
                        })
                      }
                    />
                  </div>
                  {MOMENTS.map((m) => (
                    <Check
                      key={m}
                      checked={task.advisor!.moments.includes(m)}
                      onChange={(v) => {
                        const moments = v
                          ? [...task.advisor!.moments, m]
                          : task.advisor!.moments.filter((x) => x !== m);
                        if (moments.length) update({ advisor: { ...task.advisor!, moments } });
                      }}
                    >
                      {MOMENT_LABELS[m]}
                    </Check>
                  ))}
                  <label className="flex items-center gap-1.5 text-fg-secondary">
                    at most
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={task.advisor.maxInterventions}
                      onChange={(e) =>
                        update({
                          advisor: {
                            ...task.advisor!,
                            maxInterventions: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                          },
                        })
                      }
                      className={cn(inputSized, 'w-14')}
                    />
                    times
                  </label>
                  {advisorAgent && !advisorAgent.readOnly && (
                    <span className="text-small text-danger">The advisor must be read-only.</span>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card
            title={`Pipeline (${task.pipeline.length})`}
            icon={<Repeat size={13} />}
            testId="ensemble-pipeline"
            action={
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button size="sm" data-testid="ensemble-add-stage">
                    <Plus size={12} /> Add stage
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={4} className={menuContent}>
                    {(Object.keys(STAGE_KIND_LABELS) as Stage['kind'][]).map((k) => (
                      <DropdownMenu.Item
                        key={k}
                        className={menuItem}
                        data-testid={`ensemble-add-stage-${k}`}
                        onSelect={() => addStage(k)}
                      >
                        <span className="text-fg-muted">{STAGE_ICONS[k]}</span> {STAGE_KIND_LABELS[k]}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            }
          >
            <StageLane
              task={task}
              selected={selectedStage}
              onSelect={setSelectedStage}
              onMove={moveStage}
              problems={problems}
            />
            {stage && (
              <StageEditor
                key={stage.id}
                stage={stage}
                task={task}
                problems={ofWhere(`stage:${stage.id}`)}
                onChange={(next) => setStage(stage.id, next)}
                onMove={(by) => moveStage(stage.id, by)}
                onRemove={() => {
                  const i = task.pipeline.findIndex((s) => s.id === stage.id);
                  update({ pipeline: task.pipeline.filter((s) => s.id !== stage.id) });
                  setSelectedStage(task.pipeline[i + 1]?.id ?? task.pipeline[i - 1]?.id ?? null);
                }}
              />
            )}
          </Card>

          <Card title="Limits">
            <div className="grid grid-cols-3 gap-2">
              <Field label="Budget (USD)" hint="The task pauses when its agents cost more (Usage Monitor).">
                <input
                  type="number"
                  min={0}
                  step="any"
                  data-testid="ensemble-budget"
                  value={task.limits.maxCostUsd ?? ''}
                  placeholder="no limit"
                  onChange={(e) =>
                    update({
                      limits: {
                        ...task.limits,
                        maxCostUsd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined,
                      },
                    })
                  }
                  className={input}
                />
              </Field>
              <Field label="Maximum running time (minutes)" hint="The task pauses when it is reached.">
                <input
                  type="number"
                  min={1}
                  value={task.limits.maxDurationMin ?? ''}
                  placeholder="no limit"
                  onChange={(e) =>
                    update({
                      limits: {
                        ...task.limits,
                        maxDurationMin: Number(e.target.value) > 0 ? Math.round(Number(e.target.value)) : undefined,
                      },
                    })
                  }
                  className={input}
                />
              </Field>
              <Field label="Agents working at once" hint="Parallel stages queue the rest.">
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={task.limits.maxConcurrentAgents}
                  onChange={(e) =>
                    update({
                      limits: {
                        ...task.limits,
                        maxConcurrentAgents: Math.max(1, Math.min(8, Number(e.target.value) || 1)),
                      },
                    })
                  }
                  className={input}
                />
              </Field>
            </div>
          </Card>
        </div>
      </fieldset>
      <aside className="flex w-80 flex-none flex-col border-l border-line-subtle">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <section className="flex flex-col gap-2">
            <h3 className="oxy-label">Checks</h3>
            <Checks checks={checks} task={task} />
          </section>
          <section className="flex min-h-0 flex-col gap-2">
            <h3 className="oxy-label">Prompt preview</h3>
            <PromptPreview task={task} agentId={selectedAgent} onAgent={setSelectedAgent} />
          </section>
          <p className="text-small text-fg-muted">
            Ensemble passes models and efforts per session only (command line flags): `claude` started anywhere else
            keeps your defaults. Ensemble sessions still appear in Claude Code&apos;s /resume list and share your
            account&apos;s usage limits.
          </p>
        </div>
        <div className="flex flex-none flex-col gap-2 border-t border-line-subtle bg-card p-3">
          {problems.length > 0 && (
            <div className="flex flex-col gap-0.5 text-small text-danger" data-testid="ensemble-problems">
              {problems.slice(0, 4).map((p, i) => (
                <span key={i}>• {p.message}</span>
              ))}
              {problems.length > 4 && <span>… and {problems.length - 4} more</span>}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="flex-1 text-small text-fg-muted" data-testid="ensemble-save-state">
              {locked ? '' : saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Draft'}
            </span>
            {record.run.status === 'draft' && (
              <Button
                variant="primary"
                data-testid="ensemble-builder-start"
                disabled={problems.length > 0}
                onClick={onStart}
              >
                <Play size={13} /> Start <Kbd shortcut="Mod+Enter" />
              </Button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
