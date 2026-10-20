/** Offline corpus validation, preregistration and result analysis. Never launches an agent or contacts a provider. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  EvaluationTaskSchema,
  EvaluationConfigSchema,
  EvaluationManifestSchema,
  EvaluationResultSchema,
  evaluationManifest,
  evaluationReport,
} from './lib/code-map-evaluation';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      revision: { type: 'string' },
      output: { type: 'string' },
      manifest: { type: 'string' },
      results: { type: 'string' },
      seed: { type: 'string', default: '10' },
      repeats: { type: 'string', default: '3' },
    },
  });
  const tasks = z
    .array(EvaluationTaskSchema)
    .min(20)
    .parse(JSON.parse(await readFile(resolve('scripts/fixtures/code-map-evaluation/corpus.json'), 'utf8')));
  for (const task of tasks) {
    const root = task.repository === 'oxytocin' ? resolve('.') : resolve('tests/fixtures/code-map', task.repository);
    for (const file of task.expectedFiles)
      if (!(await stat(join(root, file))).isFile()) throw new Error(`Missing expected file: ${task.id}/${file}`);
  }
  if ((positionals[0] ?? 'validate') === 'validate') {
    console.log(
      `Validated ${tasks.length} preregistered tasks (${tasks.filter((t) => t.split === 'evaluation').length} evaluation). No agent sessions were run.`,
    );
    return;
  }
  if (!values.output) throw new Error('--output is required; existing files are never overwritten');
  let result: unknown;
  if (positionals[0] === 'prepare') {
    if (!values.config || !values.revision)
      throw new Error('prepare needs --config and --revision (a full commit hash)');
    const config = EvaluationConfigSchema.parse(JSON.parse(await readFile(values.config, 'utf8')));
    result = evaluationManifest(tasks, config, values.revision, Number(values.seed), Number(values.repeats));
  } else if (positionals[0] === 'report') {
    if (!values.manifest || !values.results) throw new Error('report needs --manifest and --results (JSON array)');
    const manifest = EvaluationManifestSchema.parse(JSON.parse(await readFile(values.manifest, 'utf8')));
    const results = z.array(EvaluationResultSchema).parse(JSON.parse(await readFile(values.results, 'utf8')));
    result = evaluationReport(manifest, tasks, results);
  } else throw new Error('Use validate, prepare or report');
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote ${values.output}. No agent sessions were run.`);
}
void main().catch((e: unknown) => {
  console.error(String(e));
  process.exitCode = 1;
});
