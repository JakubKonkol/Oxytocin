import { z } from 'zod';

/**
 * Ensemble (Plan 03): a task run by a team of AI agents. A deterministic conductor (src/shared/ensemble) hands each
 * pipeline stage to the right agent, carries results from one agent to the next and asks the user at gates.
 *
 * Everything read back from disk is tolerant: unknown fields are kept (`looseObject`), so a file written by a newer
 * version never loses data when an older one saves it.
 */

export const ENSEMBLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IdSchema = z.string().regex(ENSEMBLE_ID_PATTERN, 'lower-case letters, digits and "-" (max 32)');

export const EnsembleCliSchema = z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode', 'custom']);
export type EnsembleCli = z.infer<typeof EnsembleCliSchema>;

export const RolePresetSchema = z.enum([
  'planner',
  'implementer',
  'reviewer',
  'tester',
  'researcher',
  'docs',
  'advisor',
  'custom',
]);
export type RolePreset = z.infer<typeof RolePresetSchema>;

/** Role colors: names of the palette (`--project-N` tokens), never raw colors. */
export const ROLE_COLORS = ['blue', 'green', 'amber', 'red', 'violet', 'sky', 'pink', 'teal'] as const;
export const RoleColorSchema = z.enum(ROLE_COLORS);
export type RoleColor = z.infer<typeof RoleColorSchema>;

export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const EnsembleAgentSchema = z.looseObject({
  id: IdSchema,
  name: z.string().trim().min(1).max(40),
  role: z.looseObject({
    preset: RolePresetSchema,
    label: z.string().trim().min(1).max(40),
    color: RoleColorSchema,
  }),
  cli: EnsembleCliSchema,
  /** Reserved for "Agent profiles" (account / provider); v1 uses the CLI's default account. */
  profileId: z.string().max(100).optional(),
  /** Alias or full id; empty = the CLI's default. */
  model: z.string().trim().max(200).optional(),
  /** Adapter-specific level; empty = the model's default. */
  effort: z.string().trim().max(40).optional(),
  permissionMode: PermissionModeSchema.default('default'),
  /** No edits (the adapter maps it: disallowed tools, a read-only sandbox, a plan mode). */
  readOnly: z.boolean().default(false),
  rolePrompt: z.string().max(20_000).default(''),
  /** Advanced: extra command line arguments. */
  extraArgs: z.array(z.string().max(2000)).max(40).default([]),
  /** Advanced: environment of this agent's terminal (never secrets in v1). */
  env: z.record(z.string().max(200), z.string().max(10_000)).default({}),
  /** `custom` CLI: the command (arguments are added by Oxytocin only for the prompt and MCP variables). */
  customCommand: z.string().max(2000).optional(),
});
export type EnsembleAgent = z.output<typeof EnsembleAgentSchema>;
export type EnsembleAgentInput = z.input<typeof EnsembleAgentSchema>;

export const OutputKindSchema = z.enum([
  'plan',
  'implementation',
  'review',
  'test-report',
  'research',
  'advice',
  'free',
]);
export type OutputKind = z.infer<typeof OutputKindSchema>;

export const GateShowSchema = z.enum(['plan', 'diff', 'review', 'tests', 'summary']);
export type GateShow = z.infer<typeof GateShowSchema>;

const stageBase = {
  id: IdSchema,
  title: z.string().trim().min(1).max(60),
  /** Instruction template ({{variables}}); empty = the default instruction of the output kind. */
  instruction: z.string().max(20_000).default(''),
};

export const AgentStageSchema = z.looseObject({
  ...stageBase,
  kind: z.literal('agent'),
  agentId: IdSchema,
  output: OutputKindSchema,
  /** Start a new session for this stage (e.g. an unbiased re-review). */
  freshSession: z.boolean().default(false),
});
export const ParallelStageSchema = z.looseObject({
  ...stageBase,
  kind: z.literal('parallel'),
  agentIds: z.array(IdSchema).min(2).max(8),
  output: OutputKindSchema,
  join: z.enum(['all', 'first']).default('all'),
});
export const LoopStageSchema = z.looseObject({
  ...stageBase,
  kind: z.literal('loop'),
  workerId: IdSchema,
  checkerId: IdSchema,
  maxRounds: z.number().int().min(1).max(10).default(3),
  checkerInstruction: z.string().max(20_000).default(''),
});
export const GateStageSchema = z.looseObject({
  ...stageBase,
  kind: z.literal('gate'),
  show: z.array(GateShowSchema).max(5).default(['summary']),
  onReject: z.enum(['back-to-previous', 'stop']).default('back-to-previous'),
});
export const CommandStageSchema = z.looseObject({
  ...stageBase,
  kind: z.literal('command'),
  command: z.string().trim().min(1).max(2000),
  onFail: z
    .looseObject({ agentId: IdSchema.optional(), maxAttempts: z.number().int().min(0).max(5).default(2) })
    .default({ maxAttempts: 2 }),
});

export const StageSchema = z.discriminatedUnion('kind', [
  AgentStageSchema,
  ParallelStageSchema,
  LoopStageSchema,
  GateStageSchema,
  CommandStageSchema,
]);
export type Stage = z.output<typeof StageSchema>;
export type StageKind = Stage['kind'];
export type AgentStage = z.output<typeof AgentStageSchema>;
export type ParallelStage = z.output<typeof ParallelStageSchema>;
export type LoopStage = z.output<typeof LoopStageSchema>;
export type GateStage = z.output<typeof GateStageSchema>;
export type CommandStage = z.output<typeof CommandStageSchema>;

export const AdvisorMomentSchema = z.enum(['before-plan', 'repeated-error', 'before-gate', 'before-done']);
export type AdvisorMoment = z.infer<typeof AdvisorMomentSchema>;

export const WorkspaceModeSchema = z.enum(['worktree', 'current-checkout']);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

export const EnsembleTaskSchema = z.looseObject({
  v: z.literal(1),
  id: IdSchema,
  projectId: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  /** The brief (Markdown). */
  description: z.string().max(50_000).default(''),
  generalPrompt: z.string().max(20_000).default(''),
  /** Files the agents should read first (paths relative to the project, or absolute). */
  attachments: z
    .array(z.looseObject({ path: z.string().min(1).max(1000) }))
    .max(50)
    .default([]),
  workspace: z
    .looseObject({
      mode: WorkspaceModeSchema.default('worktree'),
      /** Default: the project's current branch. */
      baseRef: z.string().trim().max(200).optional(),
      /** Default: ensemble/<task-slug>. */
      branch: z.string().trim().max(200).optional(),
      setupCommands: z.array(z.string().trim().min(1).max(2000)).max(10).default([]),
      /** Untracked files to copy into the worktree (".env", "appsettings.Development.json"). */
      copyFiles: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    })
    .default({ mode: 'worktree', setupCommands: [], copyFiles: [] }),
  /** Drafts may be incomplete; `validateTask` decides whether a task can start. */
  agents: z.array(EnsembleAgentSchema).max(12).default([]),
  pipeline: z.array(StageSchema).max(30).default([]),
  advisor: z
    .looseObject({
      agentId: IdSchema,
      moments: z.array(AdvisorMomentSchema).min(1).max(4),
      maxInterventions: z.number().int().min(1).max(20).default(5),
    })
    .optional(),
  limits: z
    .looseObject({
      maxCostUsd: z.number().positive().max(100_000).optional(),
      maxDurationMin: z.number().int().positive().max(10_000).optional(),
      maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
    })
    .default({ maxConcurrentAgents: 3 }),
  createdAt: z.number(),
  updatedAt: z.number(),
  templateId: z.string().max(100).optional(),
});
export type EnsembleTask = z.output<typeof EnsembleTaskSchema>;
export type EnsembleTaskInput = z.input<typeof EnsembleTaskSchema>;

// ── run state ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum([
  'draft',
  'preparing',
  'running',
  'paused',
  'done',
  'failed',
  'stopped',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StageStatusSchema = z.enum(['pending', 'running', 'waiting-gate', 'done', 'failed', 'skipped']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageStateSchema = z.looseObject({
  stageId: z.string(),
  status: StageStatusSchema,
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** Loops: the current round (1-based). */
  round: z.number().int().optional(),
  /** Loops: worker or checker; commands: running the command or an agent fixing it. */
  phase: z.enum(['work', 'check', 'run', 'fix']).optional(),
  /** Commands: runs so far. */
  attempts: z.number().int().optional(),
  /** Loops: the checker's last verdict. */
  verdict: z.enum(['approve', 'changes']).optional(),
  /** A gate's rejection comment sent back with the stage (revision). */
  revision: z.string().optional(),
  /** Commands: the last exit code. */
  exitCode: z.number().optional(),
  /** Commands: the terminal running it. */
  terminalId: z.string().optional(),
  /** Short outcome shown on the card ("3 findings", "exit 1"). */
  outcome: z.string().optional(),
  /** Loops: rounds the user added after the limit. */
  extraRounds: z.number().int().optional(),
});
export type StageState = z.infer<typeof StageStateSchema>;

/** Live state of an agent's CLI as the conductor sees it. */
export const AgentLiveSchema = z.enum(['starting', 'working', 'idle', 'waiting', 'unknown', 'exited']);
export type AgentLive = z.infer<typeof AgentLiveSchema>;

export const AssignmentSchema = z.looseObject({
  id: z.string(),
  stageId: z.string(),
  /** What the agent is asked to do. */
  kind: z.enum(['task', 'revision', 'review', 'fix', 'advice', 'reminder']),
  output: OutputKindSchema,
  round: z.number().int().optional(),
  createdAt: z.number(),
  /** The short message typed into the agent (the details come from oxy_ensemble_context). */
  message: z.string(),
  /** The full instruction, variables resolved. */
  instruction: z.string(),
  deliveredAt: z.number().optional(),
  delivering: z.boolean().optional(),
  /** Reminders sent after the agent stopped without submitting. */
  reminders: z.number().int().default(0),
  /** The agent went idle after the delivery (no submit yet). */
  idleSince: z.number().optional(),
  /** Waiting for the concurrency limit (parallel stages). */
  queued: z.boolean().optional(),
  /** Waiting for the advisor's advice before delivery. */
  waitingForAdvice: z.string().optional(),
  /** Advice to include with this assignment. */
  advice: z.string().optional(),
  /** Advisor assignments: the consultation they answer. */
  adviceId: z.string().optional(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const OutboxItemSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['message', 'question', 'answer', 'advice', 'notice']),
  text: z.string(),
  createdAt: z.number(),
  delivering: z.boolean().optional(),
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;

export const AgentRunStateSchema = z.looseObject({
  agentId: z.string(),
  lifecycle: z.enum(['not-started', 'starting', 'running', 'exited', 'stopped']),
  live: AgentLiveSchema.optional(),
  liveSince: z.number().optional(),
  terminalId: z.string().optional(),
  cliSessionId: z.string().optional(),
  startedAt: z.number().optional(),
  readyAt: z.number().optional(),
  /** The user types in the terminal: nothing is delivered until "Hand back". */
  takenOver: z.boolean().default(false),
  assignment: AssignmentSchema.optional(),
  outbox: z.array(OutboxItemSchema).default([]),
  lastProgress: z.looseObject({ message: z.string(), percent: z.number().optional(), at: z.number() }).optional(),
  /** Times the agent was started (restarts, fresh sessions). */
  starts: z.number().int().default(0),
  /** Working time accumulated (ms) for the cards. */
  workedMs: z.number().default(0),
  tokens: z.number().optional(),
  costUsd: z.number().optional(),
  /** Terminals and CLI sessions the agent ran in (its cost is summed over them). */
  usedTerminals: z.array(z.string()).optional(),
  usedSessions: z.array(z.string()).optional(),
  error: z.string().optional(),
});
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const FindingSchema = z.looseObject({
  file: z.string().max(1000).optional(),
  line: z.number().int().min(1).optional(),
  severity: z.enum(['blocker', 'major', 'minor', 'nit']).default('major'),
  message: z.string().min(1).max(4000),
});
export type Finding = z.infer<typeof FindingSchema>;

export const HandoffSchema = z.looseObject({
  id: z.string(),
  stageId: z.string(),
  agentId: z.string(),
  kind: OutputKindSchema,
  summary: z.string(),
  body: z.string().optional(),
  verdict: z.enum(['approve', 'changes']).optional(),
  findings: z.array(FindingSchema).optional(),
  files: z.array(z.string()).optional(),
  /** Advice: who it is for. */
  target: z.string().optional(),
  round: z.number().int().optional(),
  at: z.number(),
  /** `user`: marked as done or edited by the user; `conductor`: a command's output. */
  by: z.enum(['agent', 'user', 'conductor']).default('agent'),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const QuestionSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  question: z.string(),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  at: z.number(),
  answeredAt: z.number().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const NoteSchema = z.looseObject({ id: z.string(), by: z.string(), text: z.string(), at: z.number() });
export type Note = z.infer<typeof NoteSchema>;

export const NeedKindSchema = z.enum([
  'gate',
  'question',
  'permission',
  'not-ready',
  'stuck',
  'exited',
  'loop-limit',
  'command-failed',
  'delivery-failed',
  'limit',
  'workspace',
  'finish',
]);
export type NeedKind = z.infer<typeof NeedKindSchema>;

/** Something waiting for the user (the inbox). */
export const NeedSchema = z.looseObject({
  id: z.string(),
  kind: NeedKindSchema,
  text: z.string(),
  at: z.number(),
  agentId: z.string().optional(),
  stageId: z.string().optional(),
  questionId: z.string().optional(),
});
export type Need = z.infer<typeof NeedSchema>;

export const RunEventTypeSchema = z.enum([
  'run',
  'stage',
  'assigned',
  'delivered',
  'submitted',
  'reminder',
  'decision',
  'need',
  'gate',
  'command',
  'question',
  'answer',
  'note',
  'message',
  'advice',
  'progress',
  'state',
  'context',
  'checkpoint',
  'error',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

/** One entry of the run's timeline. Decisions name what happened, the inputs, the outcome and who decided. */
export const RunEventSchema = z.looseObject({
  id: z.number().int(),
  at: z.number(),
  type: RunEventTypeSchema,
  text: z.string(),
  agentId: z.string().optional(),
  stageId: z.string().optional(),
  /** Decisions: "rule" (the conductor) or "you" (a gate, an answer, a button). */
  by: z.enum(['rule', 'you', 'agent']).optional(),
  inputs: z.string().optional(),
  outcome: z.string().optional(),
  /** Agent states: the new state (timeline swimlanes). */
  state: AgentLiveSchema.optional(),
  /** Context served: what the agent was given. */
  items: z.array(z.string()).optional(),
  /** Handoffs: the handoff id (opens the Markdown in the Activity tab). */
  handoffId: z.string().optional(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const AdviceStateSchema = z.looseObject({
  id: z.string(),
  moment: AdvisorMomentSchema,
  question: z.string(),
  /** Agent the advice is for, or "user". */
  target: z.string(),
  stageId: z.string().optional(),
  status: z.enum(['asked', 'given', 'silent', 'taken', 'failed']),
  advice: z.string().optional(),
  at: z.number(),
  answeredAt: z.number().optional(),
});
export type AdviceState = z.infer<typeof AdviceStateSchema>;

export const WorktreeInfoSchema = z.looseObject({
  mode: WorkspaceModeSchema,
  /** The folder the agents work in. */
  path: z.string(),
  /** The repository's main checkout (merges happen there). */
  repoRoot: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  baseCommit: z.string().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const CheckpointSchema = z.looseObject({
  stageId: z.string(),
  title: z.string(),
  commit: z.string(),
  at: z.number(),
  files: z.number().optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const EnsembleRunSchema = z.looseObject({
  v: z.literal(1),
  status: RunStatusSchema,
  /** Index of the current stage (pipeline.length when every stage is done). */
  stageIndex: z.number().int().default(0),
  stages: z.array(StageStateSchema).default([]),
  agents: z.record(z.string(), AgentRunStateSchema).default({}),
  handoffs: z.array(HandoffSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  needs: z.array(NeedSchema).default([]),
  events: z.array(RunEventSchema).default([]),
  /** Total events ever recorded (older ones are moved to the artifacts folder). */
  eventCount: z.number().int().default(0),
  advice: z.array(AdviceStateSchema).default([]),
  advisorEnabled: z.boolean().default(true),
  worktree: WorktreeInfoSchema.optional(),
  checkpoints: z.array(CheckpointSchema).default([]),
  /** Waiting for the checkpoint commit of this stage before moving on. */
  pendingCheckpoint: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** Running since (unset while paused or ended). */
  runningSince: z.number().optional(),
  /** The user chose "Continue anyway" after a limit was reached. */
  limitOverride: z.boolean().optional(),
  /** The advisor was consulted before the end of the run. */
  advisedBeforeDone: z.boolean().optional(),
  /** Accumulated running time (ms) of earlier sessions (pauses and restarts do not count). */
  activeMs: z.number().default(0),
  error: z.string().optional(),
  /** Why the run is paused (a limit, the user). */
  pauseReason: z.string().optional(),
  /** Finished through the finish dialog (merged, kept, discarded). */
  finished: z.looseObject({ action: z.string(), at: z.number(), detail: z.string().optional() }).optional(),
  /** Counter for ids (assignments, needs, handoffs…). */
  seq: z.number().int().default(0),
  costUsd: z.number().optional(),
});
export type EnsembleRun = z.infer<typeof EnsembleRunSchema>;

/** A task with its run, as stored and as sent to the renderer. */
export const EnsembleRecordSchema = z.looseObject({ task: EnsembleTaskSchema, run: EnsembleRunSchema });
export type EnsembleRecord = z.infer<typeof EnsembleRecordSchema>;

// ── submissions (oxy_ensemble_submit) ─────────────────────────────────────────────────────────────────────────────

export const SubmissionSchema = z.object({
  kind: OutputKindSchema,
  summary: z.string().trim().min(1).max(4000),
  body: z.string().max(200_000).optional(),
  verdict: z.enum(['approve', 'changes']).optional(),
  findings: z.array(FindingSchema).max(200).optional(),
  files: z.array(z.string().max(1000)).max(500).optional(),
  /** Advice: the agent's name it is for, or "user". */
  target: z.string().max(100).optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

// ── CLI detection (builder checks) ─────────────────────────────────────────────────────────────────────────────────

export const CliStatusSchema = z.object({
  cli: EnsembleCliSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  command: z.string(),
  problem: z.string().optional(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

export const EnsembleChecksSchema = z.object({
  clis: z.array(CliStatusSchema),
  mcp: z.object({ enabled: z.boolean(), running: z.boolean(), error: z.string().nullable() }),
  /** The Claude Code Bridge plugin is on (exact agent states). */
  bridge: z.boolean(),
  repo: z.object({
    isRepo: z.boolean(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    dirty: z.number(),
    error: z.string().optional(),
  }),
  untracked: z.array(z.string()),
});
export type EnsembleChecks = z.infer<typeof EnsembleChecksSchema>;

/** Files changed in the task's worktree (Changes tab). */
export const EnsembleChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  binary: z.boolean().optional(),
});
export type EnsembleChange = z.infer<typeof EnsembleChangeSchema>;

export const FinishActionSchema = z.enum(['merge', 'squash', 'keep', 'discard']);
export type FinishAction = z.infer<typeof FinishActionSchema>;

/** Summary of a task for the task list (without the full run). */
export interface EnsembleSummary {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  needs: number;
  stagesDone: number;
  stagesTotal: number;
  updatedAt: number;
}

export function summarize(record: EnsembleRecord): EnsembleSummary {
  return {
    id: record.task.id,
    projectId: record.task.projectId,
    title: record.task.title,
    status: record.run.status,
    needs: record.run.needs.length,
    stagesDone: record.run.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    stagesTotal: record.task.pipeline.length,
    updatedAt: record.task.updatedAt,
  };
}

export const OUTPUT_LABELS: Record<OutputKind, string> = {
  plan: 'Plan',
  implementation: 'Implementation',
  review: 'Review',
  'test-report': 'Test report',
  research: 'Research',
  advice: 'Advice',
  free: 'Result',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: 'Draft',
  preparing: 'Preparing',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

/** Statuses of a run that has agents or commands alive. */
export const isActiveStatus = (s: RunStatus): boolean => s === 'preparing' || s === 'running' || s === 'paused';
