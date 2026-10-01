import type { AgentLive, EnsembleRun, EnsembleTask, RunEvent, Stage, StageStatus } from '../domain/ensemble';
import { stageAgents } from './conductor';

/** Derivations for the Flow view (pure: the renderer only draws them). */

export interface StepperItem {
  stageId: string;
  title: string;
  kind: Stage['kind'];
  status: StageStatus;
  current: boolean;
  /** "round 2/3", "3 agents", "attempt 2". */
  detail?: string;
}

export function stepper(task: EnsembleTask, run: EnsembleRun): StepperItem[] {
  return task.pipeline.map((stage, i) => {
    const st = run.stages.find((s) => s.stageId === stage.id);
    const status = st?.status ?? 'pending';
    let detail: string | undefined;
    if (stage.kind === 'loop' && st?.round) detail = `round ${st.round}/${stage.maxRounds + (st.extraRounds ?? 0)}`;
    else if (stage.kind === 'parallel') detail = `${stage.agentIds.length} agents`;
    else if (stage.kind === 'command' && (st?.attempts ?? 0) > 1) detail = `attempt ${st!.attempts}`;
    return {
      stageId: stage.id,
      title: stage.title,
      kind: stage.kind,
      status,
      current: run.status !== 'draft' && i === run.stageIndex && status !== 'done',
      ...(detail ? { detail } : {}),
    };
  });
}

export type LaneSegmentState = 'working' | 'idle' | 'waiting' | 'starting' | 'exited';

export interface LaneSegment {
  from: number;
  to: number;
  state: LaneSegmentState;
}

export interface LaneMarker {
  at: number;
  kind: 'handoff' | 'advice' | 'gate' | 'decision' | 'error' | 'question' | 'message';
  text: string;
  eventId: number;
}

export interface Lane {
  id: string;
  label: string;
  segments: LaneSegment[];
  markers: LaneMarker[];
}

export interface TimelineModel {
  start: number;
  end: number;
  lanes: Lane[];
  bands: { stageId: string; title: string; from: number; to: number }[];
}

const MARKER_OF: Partial<Record<RunEvent['type'], LaneMarker['kind']>> = {
  submitted: 'handoff',
  advice: 'advice',
  gate: 'gate',
  decision: 'decision',
  error: 'error',
  question: 'question',
  answer: 'question',
  message: 'message',
};

const asSegmentState = (s: AgentLive | undefined): LaneSegmentState | undefined =>
  s === 'working' || s === 'idle' || s === 'waiting' || s === 'starting' || s === 'exited' ? s : undefined;

/** Swimlanes: one per agent plus the conductor (and the advisor), state segments and point markers. */
export function timeline(task: EnsembleTask, run: EnsembleRun, now: number): TimelineModel {
  const events = run.events;
  const start = run.startedAt ?? events[0]?.at ?? now;
  const end = Math.max(start + 1000, run.endedAt ?? now);
  const advisorId = task.advisor?.agentId;
  const lanes: Lane[] = [];
  const conductor: Lane = { id: 'conductor', label: 'conductor', segments: [], markers: [] };
  const byAgent = new Map<string, Lane>();
  for (const a of task.agents)
    byAgent.set(a.id, {
      id: a.id,
      label: a.id === advisorId ? `${a.name} (advisor)` : a.name,
      segments: [],
      markers: [],
    });
  const open = new Map<string, LaneSegment>();
  for (const e of events) {
    const lane = e.agentId ? byAgent.get(e.agentId) : undefined;
    if (e.type === 'state' && lane) {
      const state = asSegmentState(e.state);
      if (!state) continue;
      const current = open.get(lane.id);
      if (current) current.to = e.at;
      const seg = { from: e.at, to: end, state };
      lane.segments.push(seg);
      open.set(lane.id, seg);
      continue;
    }
    const kind = MARKER_OF[e.type];
    if (!kind) continue;
    const marker = { at: e.at, kind, text: e.text, eventId: e.id };
    if (e.type === 'decision' || !lane) conductor.markers.push(marker);
    else lane.markers.push(marker);
  }
  for (const seg of open.values()) if (seg.state === 'exited') seg.to = seg.from;
  lanes.push(conductor);
  for (const a of task.agents) lanes.push(byAgent.get(a.id)!);
  const bands = task.pipeline
    .map((s) => {
      const st = run.stages.find((x) => x.stageId === s.id);
      if (!st?.startedAt) return null;
      return { stageId: s.id, title: s.title, from: st.startedAt, to: st.endedAt ?? end };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  return { start, end, lanes, bands };
}

export interface WhoSees {
  id: string;
  label: string;
  /** Items seen (the conductor: every event). */
  count: number;
  caption: string;
  items: string[];
}

/** How much of the run each participant saw. */
export function whoSeesWhat(task: EnsembleTask, run: EnsembleRun): WhoSees[] {
  const out: WhoSees[] = [
    {
      id: 'conductor',
      label: 'conductor',
      count: run.eventCount,
      caption: 'every event',
      items: [],
    },
  ];
  const advisorId = task.advisor?.agentId;
  for (const a of task.agents) {
    const served = run.events.filter((e) => e.type === 'context' && e.agentId === a.id);
    const items = [...new Set(served.flatMap((e) => e.items ?? []))];
    const messages = run.events.filter((e) => e.type === 'message' && e.agentId === a.id).length;
    let caption: string;
    if (a.id === advisorId) {
      const moments = run.advice.length;
      caption = `${moments} moment${moments === 1 ? '' : 's'}`;
    } else if (items.length === 0) caption = 'nothing yet';
    else
      caption =
        items
          .filter((i) => !i.startsWith('assignment'))
          .slice(0, 3)
          .join(' + ') || 'its assignments';
    out.push({
      id: a.id,
      label: a.name,
      count: served.length + messages,
      caption,
      items: [...items, ...(messages ? [`${messages} message${messages === 1 ? '' : 's'}`] : [])],
    });
  }
  return out;
}

/** The agents of a stage in display order (a loop: worker, then checker). */
export function agentsOfStage(stage: Stage): string[] {
  return stageAgents(stage);
}

/** "1:05", "12:40", "2:01:10". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
