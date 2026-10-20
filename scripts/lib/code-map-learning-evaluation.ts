import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvaluationConfigSchema, type EvaluationConfig } from './code-map-evaluation';
import { corpus, sessions } from '../fixtures/code-map-learning-evaluation/corpus';

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const arms = ['baseline', 'A', 'B-review', 'B-auto'] as const;
const count = z.number().int().nonnegative();
const measured = z.number().nonnegative().nullable();
export const LearningManifestSchema = z
  .object({
    format: z.literal('oxytocin.code-map.learning-evaluation'),
    version: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    seed: count,
    repeats: z.number().int().min(3),
    corpusHash: z.string(),
    configHash: z.string(),
    config: EvaluationConfigSchema,
    // No product Automatic mode: a separately isolated adapter must implement this frozen policy.
    autoPolicy: z.literal('evidence-current-nonconflicting-constraints-v1'),
    runs: z.array(
      z
        .object({
          id: z.string(),
          sequence: z.string(),
          arm: z.enum(arms),
          repeat: count,
          checkout: z.string(),
          memory: z.string(),
          sessions: z.array(z.string()).length(4),
        })
        .strict(),
    ),
  })
  .strict();
export type LearningManifest = z.infer<typeof LearningManifestSchema>;
export function learningManifest(config: EvaluationConfig, revision: string, seed = 14, repeats = 3): LearningManifest {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const runs = corpus.flatMap((sequence) =>
    Array.from({ length: repeats }, (_, i) => {
      const order = [...arms];
      for (let j = order.length - 1; j > 0; j--) {
        const k = Math.floor(random() * (j + 1));
        [order[j], order[k]] = [order[k]!, order[j]!];
      }
      return order.map((arm) => {
        const id = `${sequence.id}-${i + 1}-${arm}`;
        return {
          id,
          sequence: sequence.id,
          arm,
          repeat: i + 1,
          checkout: `${id}/checkout`,
          memory: `${id}/checkout/.oxy/learnings`,
          sessions: sessions.map((s) => `${id}-${s.id}`),
        };
      });
    }).flat(),
  );
  return LearningManifestSchema.parse({
    format: 'oxytocin.code-map.learning-evaluation',
    version: 1,
    revision,
    seed,
    repeats,
    corpusHash: hash({ corpus, sessions }),
    configHash: hash(EvaluationConfigSchema.parse(config)),
    config,
    autoPolicy: 'evidence-current-nonconflicting-constraints-v1',
    runs,
  });
}
export const LearningSessionResultSchema = z
  .object({
    runId: z.string(),
    session: z.string(),
    checkout: z.string(),
    memory: z.string(),
    corpusHash: z.string(),
    configHash: z.string(),
    revision: z.string(),
    success: z.boolean(),
    repeatedErrors: count,
    harmfulClaims: z.array(z.string()),
    tokens: z.object({ uncachedInput: measured, cachedInput: measured, output: measured }).strict(),
    costUsd: measured,
    explorationCostUsd: measured,
    costSource: z.string().nullable(),
    rawUsageArtifact: z.string().nullable(),
    durationMs: measured,
    peakRssBytes: measured,
    correctionMinutes: measured,
    reviewMinutes: measured,
    proposals: count.nullable(),
    rejected: count.nullable(),
    duplicates: count.nullable(),
    emitted: count.nullable(),
    useful: count.nullable(),
    relevantAvailable: count.nullable(),
    relevantRetrieved: count.nullable(),
    wrongScopeUses: count.nullable(),
    invalidatedUses: count.nullable(),
    validationArtifact: z.string().min(1),
    rubricArtifact: z.string().nullable(),
    isolationArtifact: z.string().min(1),
    autoPolicyArtifact: z.string().nullable(),
  })
  .strict()
  .refine((r) => r.useful === null || r.emitted === null || r.useful <= r.emitted, 'Useful exceeds emitted')
  .refine(
    (r) => r.relevantRetrieved === null || r.relevantAvailable === null || r.relevantRetrieved <= r.relevantAvailable,
    'Retrieved exceeds relevant',
  );
export type LearningSessionResult = z.infer<typeof LearningSessionResultSchema>;
const median = (numbers: number[]) => {
  const n = [...numbers].sort((a, b) => a - b),
    i = Math.floor(n.length / 2);
  return n.length ? (n.length % 2 ? n[i]! : (n[i - 1]! + n[i]!) / 2) : null;
};
const sum = (rows: LearningSessionResult[], field: keyof LearningSessionResult): number | null => {
  const values = rows.map((r) => r[field]);
  return rows.length && values.every((v) => typeof v === 'number') ? values.reduce((a, b) => a + b, 0) : null;
};
export function learningReport(
  manifestInput: LearningManifest,
  input: LearningSessionResult[],
  deterministic: { wrongScopeUses: number; invalidatedUses: number; artifact: string } | null,
) {
  const manifest = LearningManifestSchema.parse(manifestInput);
  if (
    JSON.stringify(manifest) !==
    JSON.stringify(learningManifest(manifest.config, manifest.revision, manifest.seed, manifest.repeats))
  )
    throw new Error('Preregistered corpus/manifest changed');
  const results = input.map((r) => LearningSessionResultSchema.parse(r));
  const seen = new Set<string>();
  for (const r of results) {
    const run = manifest.runs.find((run) => run.id === r.runId);
    if (
      !run ||
      !run.sessions.includes(r.session) ||
      r.checkout !== run.checkout ||
      r.memory !== run.memory ||
      r.corpusHash !== manifest.corpusHash ||
      r.configHash !== manifest.configHash ||
      r.revision !== manifest.revision ||
      seen.has(r.session)
    )
      throw new Error('Result identity/isolation mismatch');
    seen.add(r.session);
  }
  const missing = manifest.runs.flatMap((r) => r.sessions.filter((s) => !seen.has(s)));
  const armSummary = (arm: (typeof arms)[number]) => {
    const rows = results.filter((r) => manifest.runs.find((run) => run.id === r.runId)!.arm === arm);
    const emitted = sum(rows, 'emitted'),
      useful = sum(rows, 'useful'),
      available = sum(rows, 'relevantAvailable'),
      retrieved = sum(rows, 'relevantRetrieved');
    const sequences = manifest.runs
      .filter((run) => run.arm === arm)
      .flatMap((run) => {
        const all = rows.filter((r) => r.runId === run.id);
        return all.length === 4
          ? [
              {
                runId: run.id,
                totalCostUsd: sum(all, 'costUsd'),
                reviewMinutes: sum(all, 'reviewMinutes'),
                correctionMinutes: sum(all, 'correctionMinutes'),
              },
            ]
          : [];
      });
    const first = rows.filter((r) => r.session.endsWith('-discover'));
    const followups = rows.filter((r) => r.session.endsWith('-related') || r.session.endsWith('-mutated'));
    return {
      sessions: rows.length,
      successes: rows.filter((r) => r.success).length,
      repeatedErrors: sum(rows, 'repeatedErrors'),
      totalCostUsd: sum(rows, 'costUsd'),
      firstCaptureCostUsd: sum(first, 'costUsd'),
      amortizedSequenceCostUsd: median(sequences.flatMap((s) => (s.totalCostUsd === null ? [] : [s.totalCostUsd]))),
      relatedExplorationMedianUsd: median(
        followups.flatMap((r) => (r.explorationCostUsd === null ? [] : [r.explorationCostUsd])),
      ),
      inputTokens:
        rows.length && rows.every((r) => r.tokens.uncachedInput !== null)
          ? rows.reduce((n, r) => n + (r.tokens.uncachedInput ?? 0), 0)
          : null,
      cachedInputTokens:
        rows.length && rows.every((r) => r.tokens.cachedInput !== null)
          ? rows.reduce((n, r) => n + (r.tokens.cachedInput ?? 0), 0)
          : null,
      outputTokens:
        rows.length && rows.every((r) => r.tokens.output !== null)
          ? rows.reduce((n, r) => n + (r.tokens.output ?? 0), 0)
          : null,
      durationMs: sum(rows, 'durationMs'),
      peakRssBytes:
        !rows.length || rows.some((r) => r.peakRssBytes === null)
          ? null
          : Math.max(...rows.map((r) => r.peakRssBytes!)),
      proposals: sum(rows, 'proposals'),
      rejected: sum(rows, 'rejected'),
      duplicates: sum(rows, 'duplicates'),
      usefulnessPrecision: emitted && useful !== null ? useful / emitted : null,
      retrievalRecall: available && retrieved !== null ? retrieved / available : null,
      wrongScopeUses: sum(rows, 'wrongScopeUses'),
      invalidatedUses: sum(rows, 'invalidatedUses'),
      sequences,
    };
  };
  const grouped = {
    baseline: armSummary('baseline'),
    A: armSummary('A'),
    'B-review': armSummary('B-review'),
    'B-auto': armSummary('B-auto'),
  };
  const incompleteMetrics = results.flatMap((r) =>
    Object.entries(r)
      .filter(([key, value]) => value === null && !['autoPolicyArtifact'].includes(key))
      .map(([key]) => `${r.session}:${key}`),
  );
  for (const r of results)
    for (const [key, value] of Object.entries(r.tokens))
      if (value === null) incompleteMetrics.push(`${r.session}:tokens.${key}`);
  const harms = results.flatMap((r) => r.harmfulClaims.map((claim) => ({ session: r.session, claim })));
  const worseCases = results.flatMap((r) => {
    const run = manifest.runs.find((run) => run.id === r.runId)!;
    if (!run.arm.startsWith('B-')) return [];
    const baseRun = manifest.runs.find((b) => b.arm === 'A' && b.sequence === run.sequence && b.repeat === run.repeat)!;
    const base = results.find((b) => b.session === baseRun.sessions[run.sessions.indexOf(r.session)]);
    return base &&
      ((!r.success && base.success) || (r.costUsd !== null && base.costUsd !== null && r.costUsd > base.costUsd))
      ? [
          {
            session: r.session,
            correctnessRegression: !r.success && base.success,
            costDeltaUsd: r.costUsd !== null && base.costUsd !== null ? r.costUsd - base.costUsd : null,
          },
        ]
      : [];
  });
  const gates = Object.fromEntries(
    (['B-review', 'B-auto'] as const).map((arm) => {
      const candidate = grouped[arm],
        baseline = grouped.A;
      const costBenefit =
        baseline.relatedExplorationMedianUsd !== null &&
        baseline.relatedExplorationMedianUsd > 0 &&
        candidate.relatedExplorationMedianUsd !== null &&
        candidate.relatedExplorationMedianUsd <= baseline.relatedExplorationMedianUsd * 0.9;
      const errorBenefit =
        candidate.repeatedErrors !== null &&
        baseline.repeatedErrors !== null &&
        candidate.repeatedErrors < baseline.repeatedErrors;
      const rows = results.filter((r) => manifest.runs.find((run) => run.id === r.runId)!.arm === arm);
      const regression = worseCases.some((c) => rows.some((r) => r.session === c.session) && c.correctnessRegression);
      const complete =
        !missing.length && !incompleteMetrics.length && (arm !== 'B-auto' || rows.every((r) => r.autoPolicyArtifact));
      const deterministicPassed =
        !!deterministic?.artifact && deterministic.wrongScopeUses === 0 && deterministic.invalidatedUses === 0;
      return [
        arm,
        {
          status:
            !complete || !deterministic
              ? 'unmeasured'
              : deterministicPassed &&
                  !regression &&
                  candidate.successes >= baseline.successes &&
                  (candidate.usefulnessPrecision ?? 0) >= 0.8 &&
                  candidate.wrongScopeUses === 0 &&
                  candidate.invalidatedUses === 0 &&
                  !rows.some((r) => r.harmfulClaims.length) &&
                  (costBenefit || errorBenefit)
                ? 'passed'
                : 'failed',
          costBenefit,
          errorBenefit,
          deterministicPassed,
        },
      ];
    }),
  );
  return {
    format: 'oxytocin.code-map.learning-evaluation-report',
    manifestHash: hash(manifest),
    missing,
    incompleteMetrics,
    grouped,
    gates,
    harms,
    worseCases,
    deterministic,
    automaticAvailable: false,
    note: 'Offline report only. Product admission requires a separately reviewed release decision. Counts and characters are never token or cost savings.',
  };
}
