import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  EvaluationConfigSchema,
  EvaluationTaskSchema,
  EvaluationResultSchema,
  evaluationManifest,
  evaluationReport,
  type EvaluationResult,
} from './lib/code-map-evaluation';
import { z } from 'zod';

const tasks = z
  .array(EvaluationTaskSchema)
  .parse(JSON.parse(await readFile('scripts/fixtures/code-map-evaluation/corpus.json', 'utf8')));
const config = EvaluationConfigSchema.parse({
  agent: 'synthetic-test',
  agentVersion: '1',
  model: 'synthetic-test',
  modelVersion: '1',
  settings: {},
  provider: 'test',
  pricingCapturedAt: '2026-10-20T12:00:00.000Z',
  pricingSource: 'synthetic test rates',
  ratesUsdPerMillion: { uncachedInput: 2, cachedInput: 1, output: 4 },
  timeoutMs: 60000,
});
const manifest = () => evaluationManifest(tasks, config, 'a'.repeat(40));
function synthetic() {
  const run = manifest();
  const results: EvaluationResult[] = run.jobs.map((job) =>
    EvaluationResultSchema.parse({
      jobId: job.id,
      corpusSha256: run.corpusSha256,
      configSha256: run.configSha256,
      revision: run.revision,
      session: job.session,
      checkout: job.checkout,
      instructionsSha256: 'b'.repeat(64),
      status: 'completed',
      accepted: true,
      regressions: 0,
      review: 'Synthetic test only',
      acceptanceLog: 'test://acceptance',
      rawUsageArtifact: 'test://usage',
      durationMs: 1000,
      tokens: { uncachedInput: job.enabled ? 800 : 1000, cachedInput: 100, output: 50 },
      explorationCalls: job.enabled ? 8 : 10,
      toolCalls: 12,
      mapQueries: job.enabled ? 3 : 0,
      emptySearches: 0,
      failedSearches: 0,
      indexSetupMs: 10,
      indexUpdateMs: 2,
      peakRssBytes: 1024,
      instructionTokens: 20,
      toolSchemaTokens: 30,
      recallAt8: 1,
      relations: { tp: 2, fp: 0, fn: 0 },
    }),
  );
  return { run, results };
}
it('preregisters at least twenty tasks, balanced randomized pairs and independent fresh sessions', () => {
  const run = manifest();
  expect(tasks.length).toBeGreaterThanOrEqual(20);
  expect(new Set(tasks.map((t) => t.category)).size).toBe(9);
  expect(run.jobs).toHaveLength(tasks.length * 6);
  expect(new Set(run.jobs.map((j) => j.checkout)).size).toBe(run.jobs.length);
  expect(run).toEqual(manifest());
  expect(evaluationManifest(tasks, config, run.revision, 11).jobs).not.toEqual(run.jobs);
  expect(() => evaluationManifest(tasks, config, run.revision, 10, 2)).toThrow();
  expect(evaluationReport(run, tasks, [])).toMatchObject({ measured: false, gate: 'unverified' });
});
it('reports paired evidence, costs, first/repeated distributions and retains harmed tasks and failures', () => {
  const { run, results } = synthetic();
  const report = evaluationReport(run, tasks, results);
  expect(report.gate).toBe('passed');
  expect(report.tokenReduction).toBeCloseTo(0.2);
  expect(report.pairs[0]!.costUsd.off).toBeCloseTo(0.0023);
  expect(report.first.off!.durationMs.n).toBe(tasks.filter((t) => t.split === 'evaluation').length);
  const on = results.find(
    (r) => run.jobs.find((j) => j.id === r.jobId)?.enabled && report.pairs.some((p) => p.on.jobId === r.jobId),
  )!;
  on.status = 'timeout';
  on.accepted = false;
  on.durationMs = 60000;
  const failed = evaluationReport(run, tasks, results);
  expect(failed.gate).toBe('failed');
  expect(failed.harmed.length).toBeGreaterThan(0);
  expect(failed.pairs.some((p) => p.on.status === 'timeout')).toBe(true);
});
it('refuses mixed revisions, duplicate sessions and instruction drift; unknown metrics never count as zero', () => {
  const { run, results } = synthetic();
  results[0]!.revision = 'c'.repeat(40);
  expect(() => evaluationReport(run, tasks, results)).toThrow('preregistered');
  results[0]!.revision = run.revision;
  results[0]!.session = results[1]!.session;
  expect(() => evaluationReport(run, tasks, results)).toThrow('independent');
  results[0]!.session = run.jobs[0]!.session;
  for (const r of results) {
    r.tokens.uncachedInput = null;
    r.explorationCalls = null;
  }
  expect(evaluationReport(run, tasks, results)).toMatchObject({
    gate: 'unverified',
    tokenReduction: null,
    explorationCallReduction: null,
  });
  const evaluated = results.find((r) =>
    tasks.some((t) => t.split === 'evaluation' && run.jobs.find((j) => j.id === r.jobId)?.taskId === t.id),
  )!;
  evaluated.instructionsSha256 = 'c'.repeat(64);
  expect(() => evaluationReport(run, tasks, results)).toThrow('instructions differ');
});
