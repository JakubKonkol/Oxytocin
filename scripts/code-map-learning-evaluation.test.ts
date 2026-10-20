import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { corpus, sessions } from './fixtures/code-map-learning-evaluation/corpus';
import { learningManifest, learningReport, type LearningSessionResult } from './lib/code-map-learning-evaluation';
import { EvaluationConfigSchema } from './lib/code-map-evaluation';

const config = EvaluationConfigSchema.parse({
  agent: 'offline-test',
  agentVersion: '1',
  model: 'unrun',
  modelVersion: '1',
  settings: {},
  provider: 'none',
  pricingCapturedAt: '2026-10-20T00:00:00.000Z',
  pricingSource: 'test-only',
  ratesUsdPerMillion: { uncachedInput: 1, cachedInput: 1, output: 1 },
  timeoutMs: 1000,
});
const manifest = () => learningManifest(config, 'a'.repeat(40));
it('freezes ten distinct protocols and validates both pre- and post-mutation references', async () => {
  expect(corpus).toHaveLength(10);
  for (const sequence of corpus)
    for (const [expression, cases] of [
      [sequence.initial, sequence.cases],
      [sequence.updated, sequence.changed],
    ] as const) {
      for (const [input, expected] of cases)
        expect(JSON.stringify(await runInNewContext(`(${expression})`, { x: input }))).toBe(JSON.stringify(expected));
    }
});
it('isolates four arms and repeats with independent sessions, then reports unmeasured rather than synthetic savings', () => {
  const m = manifest();
  expect(m.runs).toHaveLength(120);
  expect(new Set(m.runs.map((r) => r.memory)).size).toBe(120);
  expect(new Set(m.runs.flatMap((r) => r.sessions)).size).toBe(480);
  expect(sessions).toHaveLength(4);
  expect(m).toEqual(manifest());
  expect(m.runs.map((r) => r.arm)).not.toEqual(learningManifest(config, 'a'.repeat(40), 17).runs.map((r) => r.arm));
  const report = learningReport(m, [], null);
  expect(report.missing).toHaveLength(480);
  expect(report.gates['B-auto']).toMatchObject({ status: 'unmeasured' });
  expect(report.automaticAvailable).toBe(false);
});
function complete(): LearningSessionResult[] {
  const m = manifest();
  return m.runs.flatMap((run) =>
    run.sessions.map((session) => ({
      runId: run.id,
      session,
      checkout: run.checkout,
      memory: run.memory,
      corpusHash: m.corpusHash,
      configHash: m.configHash,
      revision: m.revision,
      success: true,
      repeatedErrors: 0,
      harmfulClaims: [],
      tokens: { uncachedInput: 100, cachedInput: 0, output: 20 },
      costUsd: 1,
      explorationCostUsd: run.arm.startsWith('B-') ? 0.5 : 1,
      costSource: 'fixture only',
      rawUsageArtifact: 'fixture.json',
      durationMs: 10,
      peakRssBytes: 100,
      correctionMinutes: 0,
      reviewMinutes: run.arm === 'B-review' ? 1 : 0,
      proposals: 1,
      rejected: 0,
      duplicates: 0,
      emitted: 1,
      useful: 1,
      relevantAvailable: 1,
      relevantRetrieved: 1,
      wrongScopeUses: 0,
      invalidatedUses: 0,
      validationArtifact: 'fixture.json',
      rubricArtifact: 'fixture.json',
      isolationArtifact: 'fixture.json',
      autoPolicyArtifact: run.arm === 'B-auto' ? 'fixture.json' : null,
    })),
  );
}
it('fails closed on missing costs, contamination, identity mismatches, harmful claims and paired regressions', () => {
  const m = manifest(),
    rows = complete(),
    deterministic = { wrongScopeUses: 0, invalidatedUses: 0, artifact: 'fixture only' };
  expect(learningReport(m, rows, deterministic).gates['B-auto']).toMatchObject({ status: 'passed' });
  const bad = rows.find((r) => r.runId.endsWith('B-auto'))!;
  bad.success = false;
  bad.harmfulClaims = ['Invented protocol'];
  bad.costUsd = 2;
  const report = learningReport(m, rows, deterministic);
  expect(report.gates['B-auto']).toMatchObject({ status: 'failed' });
  expect(report.harms).toHaveLength(1);
  expect(report.worseCases).toContainEqual(
    expect.objectContaining({ session: bad.session, correctnessRegression: true }),
  );
  bad.tokens.output = null;
  expect(learningReport(m, rows, deterministic).gates['B-auto']).toMatchObject({ status: 'unmeasured' });
  bad.memory = 'other-arm';
  expect(() => learningReport(m, rows, deterministic)).toThrow('identity/isolation');
  expect(() => learningReport({ ...m, corpusHash: 'tampered' }, [], null)).toThrow('changed');
});
