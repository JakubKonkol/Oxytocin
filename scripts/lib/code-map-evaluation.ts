import { createHash } from 'node:crypto';
import { z } from 'zod';

export const EvaluationTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    repository: z.enum(['oxytocin', 'modules', 'csharp-solution']),
    category: z.enum([
      'subsystem',
      'caller',
      'api-change',
      'bug',
      'package',
      'worktree',
      'simple-search',
      'unsupported',
      'dynamic',
    ]),
    split: z.enum(['training', 'evaluation']),
    prompt: z.string().min(20),
    expectedFiles: z.array(z.string().min(1)).min(1),
    acceptance: z.string().min(20),
    checks: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type EvaluationTask = z.infer<typeof EvaluationTaskSchema>;
const count = z.number().int().nonnegative();
const measured = z.number().nonnegative().nullable();
export const EvaluationConfigSchema = z
  .object({
    agent: z.string().min(1),
    agentVersion: z.string().min(1),
    model: z.string().min(1),
    modelVersion: z.string().min(1),
    settings: z.record(z.string(), z.json()),
    provider: z.string().min(1),
    pricingCapturedAt: z.iso.datetime(),
    pricingSource: z.string().min(1),
    ratesUsdPerMillion: z
      .object({
        uncachedInput: z.number().nonnegative(),
        cachedInput: z.number().nonnegative(),
        output: z.number().nonnegative(),
      })
      .strict(),
    timeoutMs: z.number().int().positive(),
    maxMedianTimeRegression: z.number().min(0).max(0.1).default(0.1),
  })
  .strict();
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;
export const EvaluationJobSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    repeat: z.number().int().min(1),
    enabled: z.boolean(),
    phase: z.enum(['first', 'repeated']),
    checkout: z.string(),
    session: z.string(),
  })
  .strict();
export const EvaluationManifestSchema = z
  .object({
    format: z.literal('oxytocin.code-map.agent-evaluation'),
    version: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    seed: count,
    repeats: z.number().int().min(3),
    corpusSha256: z.string(),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    config: EvaluationConfigSchema,
    jobs: z.array(EvaluationJobSchema),
  })
  .strict();
export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;
export const EvaluationResultSchema = z
  .object({
    jobId: z.string(),
    corpusSha256: z.string(),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string(),
    session: z.string().min(1),
    checkout: z.string().min(1),
    instructionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['completed', 'failed', 'timeout']),
    accepted: z.boolean(),
    regressions: count,
    review: z.string().min(1),
    acceptanceLog: z.string().min(1),
    rawUsageArtifact: z.string().min(1),
    durationMs: z.number().nonnegative(),
    tokens: z.object({ uncachedInput: measured, cachedInput: measured, output: measured }).strict(),
    explorationCalls: measured,
    toolCalls: measured,
    mapQueries: measured,
    emptySearches: measured,
    failedSearches: measured,
    indexSetupMs: measured,
    indexUpdateMs: measured,
    peakRssBytes: measured,
    instructionTokens: measured,
    toolSchemaTokens: measured,
    recallAt8: z.number().min(0).max(1).nullable(),
    relations: z.object({ tp: count, fp: count, fn: count }).nullable(),
  })
  .strict()
  .refine((r) => r.status === 'completed' || !r.accepted, 'Failed or timed-out jobs cannot pass acceptance');
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export function evaluationManifest(
  tasks: EvaluationTask[],
  config: EvaluationConfig,
  revision: string,
  seed = 10,
  repeats = 3,
): EvaluationManifest {
  const corpus = z.array(EvaluationTaskSchema).min(20).parse(tasks);
  if (new Set(corpus.map((t) => t.id)).size !== corpus.length) throw new Error('Duplicate task IDs');
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const blocks = corpus.flatMap((task) => Array.from({ length: repeats }, (_, i) => ({ task, repeat: i + 1 })));
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
  }
  const jobs = blocks.flatMap(({ task, repeat }) => {
    const order = random() < 0.5 ? [false, true] : [true, false];
    return order.map((enabled) => {
      const id = `${task.id}-${repeat}-${enabled ? 'on' : 'off'}`;
      return {
        id,
        taskId: task.id,
        repeat,
        enabled,
        phase: repeat === 1 ? ('first' as const) : ('repeated' as const),
        checkout: `sessions/${id}/checkout`,
        session: id,
      };
    });
  });
  return EvaluationManifestSchema.parse({
    format: 'oxytocin.code-map.agent-evaluation',
    version: 1,
    revision,
    seed,
    repeats,
    corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    configSha256: createHash('sha256')
      .update(JSON.stringify(EvaluationConfigSchema.parse(config)))
      .digest('hex'),
    config,
    jobs,
  });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    at = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[at]! : (sorted[at - 1]! + sorted[at]!) / 2) : null;
};
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: median(sorted),
    p25: sorted[Math.floor((sorted.length - 1) * 0.25)] ?? null,
    p75: sorted[Math.floor((sorted.length - 1) * 0.75)] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
export function evaluationReport(
  manifestInput: EvaluationManifest,
  tasks: EvaluationTask[],
  input: EvaluationResult[],
) {
  const manifest = EvaluationManifestSchema.parse(manifestInput);
  const expected = evaluationManifest(tasks, manifest.config, manifest.revision, manifest.seed, manifest.repeats);
  if (JSON.stringify(expected) !== JSON.stringify(manifest))
    throw new Error('Manifest or corpus changed after preregistration');
  const results = input.map((r) => EvaluationResultSchema.parse(r)),
    byId = new Map(results.map((r) => [r.jobId, r]));
  if (byId.size !== results.length) throw new Error('Duplicate results');
  const sessions = new Set<string>(),
    checkouts = new Set<string>();
  for (const r of results) {
    const job = manifest.jobs.find((j) => j.id === r.jobId);
    if (
      !job ||
      r.corpusSha256 !== manifest.corpusSha256 ||
      r.configSha256 !== manifest.configSha256 ||
      r.revision !== manifest.revision
    )
      throw new Error('Result does not match the preregistered run');
    if (sessions.has(r.session) || checkouts.has(r.checkout))
      throw new Error('Sessions and fresh checkouts must be independent');
    sessions.add(r.session);
    checkouts.add(r.checkout);
  }
  const evaluation = new Set(tasks.filter((t) => t.split === 'evaluation').map((t) => t.id));
  const jobs = manifest.jobs.filter((j) => evaluation.has(j.taskId));
  const missing = jobs.filter((j) => !byId.has(j.id)).map((j) => j.id);
  const pairs = jobs
    .filter((j) => !j.enabled)
    .flatMap((offJob) => {
      const onJob = jobs.find((j) => j.enabled && j.taskId === offJob.taskId && j.repeat === offJob.repeat)!;
      const off = byId.get(offJob.id),
        on = byId.get(onJob.id);
      if (!off || !on) return [];
      if (off.instructionsSha256 !== on.instructionsSha256)
        throw new Error('Repository instructions differ within a pair');
      const rates = manifest.config.ratesUsdPerMillion;
      const cost = (r: EvaluationResult) =>
        Object.values(r.tokens).some((v) => v === null)
          ? null
          : (r.tokens.uncachedInput! * rates.uncachedInput +
              r.tokens.cachedInput! * rates.cachedInput +
              r.tokens.output! * rates.output) /
            1e6;
      return [
        {
          taskId: offJob.taskId,
          repeat: offJob.repeat,
          phase: offJob.phase,
          off,
          on,
          costUsd: { off: cost(off), on: cost(on) },
          harmed:
            (off.accepted && !on.accepted) ||
            on.regressions > off.regressions ||
            on.durationMs > off.durationMs ||
            (off.tokens.uncachedInput !== null &&
              on.tokens.uncachedInput !== null &&
              on.tokens.uncachedInput > off.tokens.uncachedInput) ||
            (off.explorationCalls !== null &&
              on.explorationCalls !== null &&
              on.explorationCalls > off.explorationCalls),
        },
      ];
    });
  const aggregate = (phase?: 'first' | 'repeated') => {
    const rows = pairs.filter((p) => !phase || p.phase === phase);
    return Object.fromEntries(
      (['off', 'on'] as const).map((mode) => [
        mode,
        {
          accepted: rows.filter((p) => p[mode].accepted).length,
          failed: rows.filter((p) => p[mode].status === 'failed').length,
          timeouts: rows.filter((p) => p[mode].status === 'timeout').length,
          durationMs: distribution(rows.map((p) => p[mode].durationMs)),
          uncachedInput: distribution(
            rows.flatMap((p) => (p[mode].tokens.uncachedInput === null ? [] : [p[mode].tokens.uncachedInput])),
          ),
          explorationCalls: distribution(
            rows.flatMap((p) => (p[mode].explorationCalls === null ? [] : [p[mode].explorationCalls])),
          ),
        },
      ]),
    );
  };
  const medians = (pick: (r: EvaluationResult) => number | null) =>
    (['off', 'on'] as const).map((mode) =>
      median(pairs.flatMap((p) => (pick(p[mode]) === null ? [] : [pick(p[mode])!]))),
    );
  const reduction = (pick: (r: EvaluationResult) => number | null) => {
    if (pairs.some((p) => pick(p.off) === null || pick(p.on) === null)) return null;
    const [off, on] = medians(pick);
    return off && on !== null && on !== undefined ? 1 - on / off : null;
  };
  const tokens = reduction((r) => r.tokens.uncachedInput),
    calls = reduction((r) => r.explorationCalls);
  const [offTime, onTime] = medians((r) => r.durationMs);
  const correctness = pairs.every((p) => (!p.off.accepted || p.on.accepted) && p.on.regressions <= p.off.regressions);
  const time =
    offTime !== null &&
    offTime !== undefined &&
    onTime !== null &&
    onTime !== undefined &&
    onTime <= offTime * (1 + manifest.config.maxMedianTimeRegression);
  const complete = !missing.length && pairs.length > 0;
  return {
    measured: results.length > 0,
    gate:
      !complete || !pairs.some((p) => p.off.accepted) || (tokens === null && calls === null)
        ? 'unverified'
        : correctness && time && ((tokens ?? 0) >= 0.15 || (calls ?? 0) >= 0.15)
          ? 'passed'
          : 'failed',
    missing,
    tokenReduction: tokens,
    explorationCallReduction: calls,
    correctness,
    time,
    all: aggregate(),
    first: aggregate('first'),
    repeated: aggregate('repeated'),
    pairs,
    harmed: pairs.filter((p) => p.harmed).map((p) => `${p.taskId}-${p.repeat}`),
    note: 'Directional paired evidence, not a statistical guarantee. Training tasks are excluded. Missing metrics are unknown, never zero. Inspect all failures and harmed tasks.',
  };
}
