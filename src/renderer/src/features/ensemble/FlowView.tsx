import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Diamond,
  Gavel,
  Repeat,
  ShieldCheck,
  SquareTerminal,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type EnsembleRecord,
  type EnsembleTask,
  type EnsembleRun,
  OUTPUT_LABELS,
  type RunEvent,
  type Stage,
  type StageState,
} from '@shared/domain/ensemble';
import { elapsedMs, MOMENT_LABELS } from '@shared/ensemble/conductor';
import { nameOf } from '@shared/ensemble/context';
import { formatCost, formatDuration, formatTokens, stepper, timeline, whoSeesWhat } from '@shared/ensemble/flow';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/Button';
import { TerminalView } from '../terminals/TerminalView';
import { AgentDrawer } from './AgentDrawer';
import { ensembleCommand, useEnsembleStore } from './ensemble-store';
import { AgentAvatar, LiveDot, liveLabel, liveOf, modelLabel, plural, roleColor, since, useNow } from './ui';

const STAGE_ICON: Record<Stage['kind'], ReactNode> = {
  agent: <Bot size={13} />,
  parallel: <Users size={13} />,
  loop: <Repeat size={13} />,
  gate: <ShieldCheck size={13} />,
  command: <SquareTerminal size={13} />,
};

const RING: Record<StageState['status'], string> = {
  pending: 'border-line-subtle',
  running: 'border-agent/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--agent)_15%,transparent)]',
  'waiting-gate': 'border-warning/70 shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_15%,transparent)]',
  done: 'border-success/50',
  failed: 'border-danger/70',
  skipped: 'border-line-subtle',
};

function StageStatusBadge({ status }: { status: StageState['status'] }) {
  const map: Record<StageState['status'], [string, string]> = {
    pending: ['pending', 'text-fg-muted'],
    running: ['running', 'text-agent'],
    'waiting-gate': ['needs you', 'text-warning'],
    done: ['done', 'text-success'],
    failed: ['failed', 'text-danger'],
    skipped: ['skipped', 'text-fg-muted'],
  };
  const [label, tone] = map[status];
  return (
    <span
      className={cn('flex items-center gap-1 font-mono text-small', tone)}
      data-testid="ensemble-stage-status"
      data-status={status}
    >
      {status === 'done' ? (
        <Check size={11} />
      ) : (
        <CircleDot size={10} className={status === 'running' ? 'ens-breathe' : ''} />
      )}
      {label}
    </span>
  );
}

/** An agent inside a stage: who, model and effort, live state, what it is doing, its outcome. */
function AgentNode({
  record,
  agentId,
  stageId,
  now,
  onPeek,
  peeked,
}: {
  record: EnsembleRecord;
  agentId: string;
  stageId: string;
  now: number;
  onPeek: (id: string) => void;
  peeked: boolean;
}) {
  const { task, run } = record;
  const agent = task.agents.find((a) => a.id === agentId);
  if (!agent)
    return <div className="rounded-control border border-danger/40 p-2 text-small text-danger">Unknown agent</div>;
  const state = run.agents[agentId];
  const kind = liveOf(state);
  const onThisStage = state?.assignment?.stageId === stageId;
  const handoff = [...run.handoffs].reverse().find((h) => h.agentId === agentId && h.stageId === stageId);
  const needs = run.needs.filter((n) => n.agentId === agentId);
  const progress = onThisStage ? state?.lastProgress : undefined;
  return (
    <button
      type="button"
      data-testid="ensemble-agent-node"
      data-agent-id={agentId}
      data-state={kind}
      onClick={() => onPeek(agentId)}
      title="Show the terminal"
      className={cn(
        'flex w-60 min-w-0 flex-col gap-1.5 rounded-control border bg-surface px-2.5 py-2 text-left transition-colors hover:bg-card-hover',
        peeked ? 'border-line-focus' : needs.length && onThisStage ? 'border-warning/70' : 'border-line-subtle',
      )}
      style={{ borderLeft: `3px solid ${roleColor(agent.role.color)}` }}
    >
      <span className="flex items-center gap-2">
        <AgentAvatar agent={agent} size={22} pulse={kind === 'working' && onThisStage} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-fg">
            {agent.name} <span className="font-normal text-fg-muted">· {agent.role.label}</span>
          </span>
          <span className="truncate font-mono text-[10px] text-fg-muted">{modelLabel(agent)}</span>
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-small text-fg-secondary">
        <LiveDot kind={kind} size={7} />
        {liveLabel(kind)}
        {state?.liveSince && (kind === 'working' || kind === 'waiting') ? ` ${since(state.liveSince, now)}` : ''}
        {state?.takenOver && <span className="text-warning">· taken over</span>}
        {state?.costUsd !== undefined && (
          <span
            className="ml-auto font-mono text-[10px] text-fg-muted"
            data-testid="ensemble-agent-cost"
            title={state.tokens !== undefined ? `${formatTokens(state.tokens)} tokens` : undefined}
          >
            {formatCost(state.costUsd)}
          </span>
        )}
      </span>
      {progress && (
        <span className="truncate text-small text-fg-muted" title={progress.message}>
          {progress.message}
        </span>
      )}
      {progress?.percent !== undefined && (
        <span className="h-1 overflow-hidden rounded-full bg-input">
          <span className="block h-full rounded-full bg-agent" style={{ width: `${progress.percent}%` }} />
        </span>
      )}
      {handoff && !onThisStage && (
        <span className="flex items-center gap-1 truncate text-small text-success" title={handoff.summary}>
          <Check size={11} className="flex-none" />
          {handoff.verdict === 'changes'
            ? `${plural(handoff.findings?.length ?? 0, 'finding')}`
            : `${OUTPUT_LABELS[handoff.kind].toLowerCase()} submitted`}
        </span>
      )}
      {onThisStage && needs.length > 0 && <span className="truncate text-small text-warning">Needs you ▸</span>}
    </button>
  );
}

function Edge({ state }: { state: 'done' | 'active' | 'pending' }) {
  return (
    <svg width="14" height="22" className="mx-auto flex-none" aria-hidden>
      <line
        x1="7"
        y1="0"
        x2="7"
        y2="22"
        strokeWidth="2"
        className={cn(state === 'active' && 'ens-edge-active')}
        style={{
          stroke: state === 'done' ? 'var(--success)' : state === 'active' ? 'var(--agent)' : 'var(--border-strong)',
          strokeDasharray: state === 'pending' ? '3 3' : undefined,
        }}
      />
    </svg>
  );
}

function StageBlock({
  record,
  stage,
  now,
  onPeek,
  onGate,
  peek,
  anchor,
}: {
  record: EnsembleRecord;
  stage: Stage;
  now: number;
  onPeek: (id: string) => void;
  onGate: (stageId: string) => void;
  peek: string | null;
  anchor: (el: HTMLElement | null) => void;
}) {
  const { run } = record;
  const st = run.stages.find((s) => s.stageId === stage.id) ?? { stageId: stage.id, status: 'pending' as const };
  const node = (id: string) => (
    <AgentNode
      key={id}
      record={record}
      agentId={id}
      stageId={stage.id}
      now={now}
      onPeek={onPeek}
      peeked={peek === id}
    />
  );
  let body: ReactNode;
  switch (stage.kind) {
    case 'agent':
      body = <div className="flex justify-center">{node(stage.agentId)}</div>;
      break;
    case 'parallel':
      body = (
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex flex-wrap justify-center gap-2">{stage.agentIds.map(node)}</div>
          <span className="font-mono text-[10px] text-fg-muted">
            join: {stage.join === 'first' ? 'first result wins' : `all ${stage.agentIds.length} results`}
          </span>
        </div>
      );
      break;
    case 'loop':
      body = (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {node(stage.workerId)}
          <div className="flex flex-col items-center gap-0.5 text-fg-muted" aria-label="review loop">
            <Repeat size={16} className={st.status === 'running' ? 'text-agent' : ''} />
            <span className="font-mono text-[10px]" data-testid="ensemble-loop-round">
              {st.round ? `round ${st.round}/${stage.maxRounds + (st.extraRounds ?? 0)}` : `max ${stage.maxRounds}`}
            </span>
            {st.verdict && (
              <span className={cn('font-mono text-[10px]', st.verdict === 'approve' ? 'text-success' : 'text-warning')}>
                {st.verdict === 'approve' ? 'approved' : 'changes'}
              </span>
            )}
          </div>
          {node(stage.checkerId)}
        </div>
      );
      break;
    case 'gate':
      body = (
        <div className="flex items-center justify-center gap-3">
          <span className="flex items-center gap-1.5 text-fg-secondary">
            <Gavel size={14} /> Your approval
          </span>
          {st.status === 'waiting-gate' && (
            <Button size="sm" variant="primary" data-testid="ensemble-flow-gate" onClick={() => onGate(stage.id)}>
              Review…
            </Button>
          )}
        </div>
      );
      break;
    case 'command': {
      const terminalId = st.terminalId;
      body = (
        <div className="flex flex-col items-center gap-1.5">
          <code className="rounded-badge border border-line-subtle bg-input px-2 py-0.5 font-mono text-small text-fg">
            {stage.command}
          </code>
          <span className="font-mono text-[10px] text-fg-muted">
            {st.status === 'running' && st.phase === 'fix'
              ? `failed — ${nameOf(record.task, stage.onFail.agentId ?? '')} is fixing it`
              : st.exitCode !== undefined
                ? `exit ${st.exitCode}${(st.attempts ?? 1) > 1 ? ` · attempt ${st.attempts}` : ''}`
                : st.status === 'running'
                  ? 'running…'
                  : ''}
          </span>
          {stage.onFail.agentId && st.phase === 'fix' && node(stage.onFail.agentId)}
          {terminalId && (
            <button
              type="button"
              className="text-small text-accent hover:underline"
              onClick={() => onPeek(`terminal:${terminalId}`)}
            >
              Show output
            </button>
          )}
        </div>
      );
      break;
    }
  }
  return (
    <section
      ref={anchor}
      data-testid="ensemble-flow-stage"
      data-stage-id={stage.id}
      data-status={st.status}
      className={cn('flex flex-col gap-2 rounded-card border bg-card px-3 py-2.5 transition-shadow', RING[st.status])}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-muted">{STAGE_ICON[stage.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{stage.title}</span>
        {st.outcome && <span className="truncate text-small text-fg-muted">{st.outcome}</span>}
        <StageStatusBadge status={st.status} />
      </div>
      {body}
    </section>
  );
}

function TeamStrip({ task, run }: { task: EnsembleTask; run: EnsembleRun }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="ensemble-team-strip">
      {task.agents.map((a) => {
        const kind = liveOf(run.agents[a.id]);
        return (
          <span
            key={a.id}
            className="flex items-center gap-1.5 rounded-full border border-line-subtle bg-card py-0.5 pr-2 pl-0.5"
            title={`${a.name} · ${a.role.label} · ${modelLabel(a)} · ${liveLabel(kind)}`}
          >
            <AgentAvatar agent={a} size={18} pulse={kind === 'working'} />
            <span className="text-small text-fg">{a.name}</span>
            <span className="font-mono text-[10px] text-fg-muted">{modelLabel(a)}</span>
            <LiveDot kind={kind} size={6} />
          </span>
        );
      })}
    </div>
  );
}

function Stepper({ record, onJump }: { record: EnsembleRecord; onJump: (stageId: string) => void }) {
  const items = stepper(record.task, record.run);
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid="ensemble-stepper">
      {items.map((s, i) => (
        <li key={s.stageId} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={11} className="text-fg-muted" aria-hidden />}
          <button
            type="button"
            onClick={() => onJump(s.stageId)}
            data-status={s.status}
            aria-current={s.current ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-0.5 text-small transition-colors',
              s.current
                ? s.status === 'waiting-gate'
                  ? 'bg-warning/15 text-warning'
                  : 'bg-agent/15 text-agent'
                : s.status === 'done'
                  ? 'text-success hover:bg-card-hover'
                  : 'text-fg-muted hover:bg-card-hover',
            )}
          >
            {s.status === 'done' ? <Check size={11} /> : <span className="font-mono text-[10px]">{i + 1}</span>}
            {s.title}
            {s.detail && <span className="font-mono text-[10px] opacity-80">({s.detail})</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function DecisionsLane({ events }: { events: RunEvent[] }) {
  const [open, setOpen] = useState(true);
  const decisions = useMemo(() => events.filter((e) => e.type === 'decision').reverse(), [events]);
  if (decisions.length === 0) return null;
  return (
    <section className="rounded-card border border-line-subtle bg-card" data-testid="ensemble-decisions">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="oxy-label flex-1">Decisions</span>
        <span className="font-mono text-small text-fg-muted">{plural(decisions.length, 'decision')}</span>
      </button>
      {open && (
        <div className="max-h-40 overflow-auto px-3 pb-2">
          <table className="w-full table-fixed text-small">
            <tbody>
              {decisions.slice(0, 40).map((d) => (
                <tr key={d.id} className="ens-fade-in align-top">
                  <td className="w-28 truncate py-0.5 pr-2 text-fg-secondary">{d.text}</td>
                  <td className="truncate py-0.5 pr-2 text-fg-muted" title={d.inputs}>
                    {d.inputs}
                  </td>
                  <td className="truncate py-0.5 pr-2 text-fg" title={d.outcome}>
                    {d.outcome}
                  </td>
                  <td
                    className={cn(
                      'w-10 py-0.5 text-right font-mono text-[10px]',
                      d.by === 'you' ? 'text-accent' : 'text-fg-muted',
                    )}
                  >
                    {d.by ?? 'rule'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdvisorRail({ record }: { record: EnsembleRecord }) {
  const { task, run } = record;
  const advisor = task.agents.find((a) => a.id === task.advisor?.agentId);
  if (!advisor || !task.advisor) return null;
  const state = run.agents[advisor.id];
  const thinking = state?.assignment?.kind === 'advice';
  return (
    <aside
      className="flex w-52 flex-none flex-col gap-2 overflow-auto border-r border-line-subtle p-3"
      data-testid="ensemble-advisor-rail"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar agent={advisor} size={22} pulse={thinking} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-fg">{advisor.name}</span>
          <span className="text-small text-fg-muted">
            {!run.advisorEnabled ? 'switched off' : thinking ? 'thinking…' : 'on call'}
          </span>
        </div>
      </div>
      <div className="relative flex flex-col gap-2 border-l border-dashed border-line pl-3">
        {run.advice.length === 0 && <span className="text-small text-fg-muted">listening…</span>}
        {run.advice.map((a) => (
          <div key={a.id} className="ens-fade-in flex flex-col gap-0.5" data-testid="ensemble-advice">
            <span className="flex items-center gap-1 text-small font-medium text-fg">
              <Diamond size={10} className="text-agent" /> {MOMENT_LABELS[a.moment]}
            </span>
            <span className="text-small text-fg-muted">{a.question}</span>
            {a.advice && <span className="line-clamp-4 text-small text-fg">» {a.advice}</span>}
            <span
              className={cn(
                'font-mono text-[10px]',
                a.status === 'given' ? 'text-success' : a.status === 'failed' ? 'text-danger' : 'text-fg-muted',
              )}
            >
              {a.status === 'silent' ? '✓ no concerns' : a.status} →{' '}
              {a.target === 'user' ? 'you' : nameOf(task, a.target)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-1.5 border-t border-line-subtle pt-2 text-small text-fg-muted">
        <span>
          calls {run.advice.length}/{task.advisor.maxInterventions} · silent on routine turns, never writes code
        </span>
        {(run.status === 'running' || run.status === 'paused') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void ensembleCommand(task.id, { type: 'advisor-enabled', enabled: !run.advisorEnabled })}
          >
            {run.advisorEnabled ? 'Switch off' : 'Switch on'}
          </Button>
        )}
      </div>
    </aside>
  );
}

const SEGMENT_CLASS: Record<string, string> = {
  working: '',
  idle: 'border-y border-dotted border-line-strong bg-transparent',
  waiting: 'ens-hatch',
  starting: 'bg-info/40',
  exited: 'bg-danger',
};

function Timeline({
  record,
  now,
  selected,
  onSelect,
}: {
  record: EnsembleRecord;
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const model = useMemo(() => timeline(record.task, record.run, now), [record, now]);
  const span = Math.max(1, model.end - model.start);
  const x = (t: number) => `${(((t - model.start) / span) * 100).toFixed(3)}%`;
  const w = (a: number, b: number) => `${Math.max(0.3, ((b - a) / span) * 100).toFixed(3)}%`;
  const color = (id: string) => {
    const a = record.task.agents.find((x2) => x2.id === id);
    return a ? roleColor(a.role.color) : 'var(--text-muted)';
  };
  return (
    <section className="flex flex-col gap-1" data-testid="ensemble-timeline">
      <div className="flex items-center gap-2">
        <h3 className="oxy-label flex-1">Timeline</h3>
        <span className="font-mono text-[10px] text-fg-muted">{formatDuration(span)}</span>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 right-0 left-24">
          {model.bands.map((b, i) => (
            <div
              key={b.stageId}
              className={cn('absolute inset-y-0 border-l border-line-subtle', i % 2 === 1 && 'bg-card-hover/40')}
              style={{ left: x(b.from), width: w(b.from, b.to) }}
            >
              <span className="absolute bottom-0 left-1 truncate font-mono text-[9px] text-fg-muted">{b.title}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 pb-3">
          {model.lanes.map((lane) => (
            <button
              type="button"
              key={lane.id}
              onClick={() => onSelect(selected === lane.id ? null : lane.id)}
              className={cn('flex h-4 items-center text-left', selected && selected !== lane.id && 'opacity-40')}
            >
              <span className="w-24 flex-none truncate pr-2 font-mono text-[10px] text-fg-secondary">{lane.label}</span>
              <span className="relative h-2.5 flex-1">
                {lane.segments.map((s, i) => (
                  <span
                    key={i}
                    className={cn('absolute inset-y-0 rounded-sm', SEGMENT_CLASS[s.state])}
                    style={{
                      left: x(s.from),
                      width: w(s.from, s.to),
                      ...(s.state === 'working' ? { background: color(lane.id) } : {}),
                    }}
                    title={`${s.state} ${formatDuration(s.to - s.from)}`}
                  />
                ))}
                {lane.markers.map((m) => (
                  <span
                    key={m.eventId}
                    title={m.text}
                    className={cn(
                      'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45',
                      m.kind === 'error'
                        ? 'bg-danger'
                        : m.kind === 'gate'
                          ? 'bg-warning'
                          : m.kind === 'advice'
                            ? 'bg-agent'
                            : 'bg-fg',
                    )}
                    style={{ left: x(m.at) }}
                  />
                ))}
              </span>
            </button>
          ))}
        </div>
        {record.run.status === 'running' && (
          <div className="absolute top-0 right-0 bottom-3 w-px bg-accent" title="now" />
        )}
      </div>
    </section>
  );
}

function WhoSees({ record, selected }: { record: EnsembleRecord; selected: string | null }) {
  const rows = whoSeesWhat(record.task, record.run);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <aside
      className="flex w-52 flex-none flex-col gap-2 overflow-auto border-l border-line-subtle p-3"
      data-testid="ensemble-who-sees"
    >
      <h3 className="oxy-label">Who sees what</h3>
      {rows.map((r) => (
        <div
          key={r.id}
          className={cn('flex flex-col gap-0.5', selected && selected !== r.id && 'opacity-50')}
          title={r.items.join('\n')}
        >
          <span className="flex items-center justify-between text-small">
            <span className="text-fg">{r.label}</span>
            <span className="font-mono text-[10px] text-fg-muted">{r.count}</span>
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-input">
            <span
              className="block h-full rounded-full bg-line-focus"
              style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }}
            />
          </span>
          <span className="truncate text-[10px] text-fg-muted">{r.caption}</span>
        </div>
      ))}
    </aside>
  );
}

function LiveLog({ record, selected }: { record: EnsembleRecord; selected: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const events = useMemo(
    () =>
      record.run.events
        .filter(
          (e) =>
            e.type !== 'context' && (!selected || e.agentId === selected || (selected === 'conductor' && !e.agentId)),
        )
        .slice(-200),
    [record.run.events, selected],
  );
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [events, follow]);
  const start = record.run.startedAt ?? events[0]?.at ?? 0;
  const color = (id?: string) => {
    const a = record.task.agents.find((x) => x.id === id);
    return a ? roleColor(a.role.color) : 'var(--text-secondary)';
  };
  return (
    <section className="flex min-h-0 flex-col gap-1" data-testid="ensemble-live-log">
      <div className="flex items-center gap-2">
        <h3 className="oxy-label flex-1">Live log</h3>
        {!follow && (
          <button type="button" className="text-small text-accent hover:underline" onClick={() => setFollow(true)}>
            Jump to live
          </button>
        )}
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 8);
        }}
        className="h-32 overflow-auto rounded-control border border-line-subtle bg-terminal px-2 py-1 font-mono text-[11px] leading-[1.55] select-text"
      >
        {events.map((e) => (
          <div key={e.id} className="flex gap-2 whitespace-nowrap">
            <span className="flex-none text-fg-muted">{formatDuration(e.at - start)}</span>
            <span className="w-16 flex-none truncate" style={{ color: color(e.agentId) }}>
              {e.agentId ? nameOf(record.task, e.agentId) : e.by === 'you' ? 'you' : 'conductor'}
            </span>
            <span
              className={cn(
                'truncate',
                e.type === 'error' ? 'text-danger' : e.type === 'need' ? 'text-warning' : 'text-fg',
              )}
            >
              {e.type === 'decision' ? `${e.text}: ${e.inputs ?? ''} ${e.outcome ?? ''}` : e.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The Flow view: the whole run on one screen. */
export function FlowView({ record, onGate }: { record: EnsembleRecord; onGate: (stageId: string) => void }) {
  const { task, run } = record;
  const now = useNow(run.status === 'running' || run.status === 'preparing', 1000);
  const peek = useEnsembleStore((s) => s.peek[task.id] ?? null);
  const setPeek = (id: string | null) => useEnsembleStore.getState().setPeek(task.id, id);
  const [selected, setSelected] = useState<string | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const [details, setDetails] = useState(true);
  const active = Object.values(run.agents).filter(
    (a) => a.lifecycle === 'running' || a.lifecycle === 'starting',
  ).length;
  const current = task.pipeline[run.stageIndex];
  const advisorState = task.advisor
    ? !run.advisorEnabled
      ? 'off'
      : run.agents[task.advisor.agentId]?.assignment?.kind === 'advice'
        ? 'thinking'
        : 'on call'
    : null;
  const decisions = run.events.filter((e) => e.type === 'decision').length;
  const peekTerminal = peek?.startsWith('terminal:') ? peek.slice('terminal:'.length) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ensemble-flow">
      <div className="flex flex-none flex-col gap-2 border-b border-line-subtle px-4 py-2">
        <TeamStrip task={task} run={run} />
        <Stepper
          record={record}
          onJump={(id) => anchors.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        {details && <AdvisorRail record={record} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {run.status === 'preparing' && (
            <div className="flex items-center gap-2 rounded-card border border-info/40 bg-info/10 px-3 py-2 text-fg">
              <CircleDot size={14} className="ens-breathe text-info" /> Preparing the workspace (worktree, setup
              commands)…
            </div>
          )}
          {details && <DecisionsLane events={run.events} />}
          <div className="flex flex-col">
            {task.pipeline.map((stage, i) => {
              const st = run.stages.find((s) => s.stageId === stage.id);
              const next = run.stages.find((s) => s.stageId === task.pipeline[i + 1]?.id);
              return (
                <div key={stage.id} className="flex flex-col">
                  <StageBlock
                    record={record}
                    stage={stage}
                    now={now}
                    peek={peek}
                    onPeek={(id) => setPeek(peek === id ? null : id)}
                    onGate={onGate}
                    anchor={(el) => {
                      if (el) anchors.current.set(stage.id, el);
                    }}
                  />
                  {i < task.pipeline.length - 1 && (
                    <Edge
                      state={
                        st?.status === 'done' && next?.status && next.status !== 'pending'
                          ? next.status === 'running' || next.status === 'waiting-gate'
                            ? 'active'
                            : 'done'
                          : 'pending'
                      }
                    />
                  )}
                </div>
              );
            })}
            {run.status === 'done' && (
              <>
                <Edge state="done" />
                <div className="flex items-center justify-center gap-2 rounded-card border border-success/50 bg-success/10 px-3 py-2 text-success">
                  <Check size={14} /> Done{run.finished ? ` — ${run.finished.detail ?? run.finished.action}` : ''}
                </div>
              </>
            )}
          </div>
          {details && (
            <>
              <Timeline record={record} now={now} selected={selected} onSelect={setSelected} />
              <LiveLog record={record} selected={selected} />
            </>
          )}
        </div>
        {details && <WhoSees record={record} selected={selected} />}
      </div>
      <footer
        className="flex flex-none items-center gap-3 border-t border-line-subtle px-4 py-1 font-mono text-[11px] text-fg-muted"
        data-testid="ensemble-status-line"
      >
        <span>stage {current ? current.title : run.status === 'done' ? 'finished' : '—'}</span>
        <span>
          agents {active}/{task.agents.length} active
        </span>
        {advisorState && <span>advisor {advisorState}</span>}
        <span>{plural(decisions, 'decision')}</span>
        {run.startedAt && <span>{formatDuration(elapsedMs(run, now))}</span>}
        {run.costUsd !== undefined && (
          <span data-testid="ensemble-run-cost">
            {formatCost(run.costUsd)}
            {task.limits.maxCostUsd ? ` of ${formatCost(task.limits.maxCostUsd)}` : ''}
          </span>
        )}
        {run.needs.length > 0 && <span className="text-warning">{run.needs.length} need you</span>}
        <button type="button" className="ml-auto hover:text-fg" onClick={() => setDetails((d) => !d)}>
          {details ? 'Hide details' : 'Details'}
        </button>
      </footer>
      {peek && !peekTerminal && <AgentDrawer record={record} agentId={peek} />}
      {peekTerminal && <CommandDrawer terminalId={peekTerminal} onClose={() => setPeek(null)} />}
    </div>
  );
}

function CommandDrawer({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  return (
    <div className="ens-fade-in absolute inset-y-0 right-0 z-20 flex w-[min(720px,62%)] flex-col border-l border-line bg-surface shadow-elevated">
      <div className="flex flex-none items-center gap-2 border-b border-line-subtle px-3 py-2">
        <SquareTerminal size={14} className="text-fg-muted" />
        <span className="flex-1 font-medium text-fg">Command output</span>
        <button type="button" aria-label="Close" className="text-fg-muted hover:text-fg" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView terminalId={terminalId} />
      </div>
    </div>
  );
}
