import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './launch';

/** Records a metric in perf-results.json (a CI artifact). */
export async function record(name: string, value: number, unit: string, budget?: number): Promise<void> {
  const file = join(repoRoot, 'perf-results.json');
  let results: Record<string, unknown>;
  try {
    results = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    results = {};
  }
  results[name] = {
    value,
    unit,
    ...(budget !== undefined ? { budget } : {}),
    platform: process.platform,
    at: new Date().toISOString(),
  };
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`perf ${name}: ${value} ${unit}${budget !== undefined ? ` (budget ${budget})` : ''}`);
}

/**
 * Checks a measured latency against its budget. Shared CI runners are slow and noisy, so a value over budget is
 * recorded and reported (a test annotation, perf-results.json) and fails the test only when it is far over
 * (`failAt`, 4× the budget by default): a real regression rather than a busy runner.
 */
export async function withinBudget(name: string, value: number, budget: number, failAt = budget * 4): Promise<void> {
  await record(name, Math.round(value), 'ms', budget);
  if (value > budget)
    test.info().annotations.push({ type: 'warning', description: `${name}: ${Math.round(value)} ms > ${budget} ms` });
  expect(value, `${name} is far over its budget of ${budget} ms`).toBeLessThan(failAt);
}
