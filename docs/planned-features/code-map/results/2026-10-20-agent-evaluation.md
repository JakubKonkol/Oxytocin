# Agent evaluation: corpus and offline harness

Date: 2026-10-20. Implementation base: `6b7b5de`; the stage 10 commit contains the final corpus and harness.
No agent/model sessions were run. No token, cost or productivity benefit has been measured. The benefit gate is
**unverified**. This follows the owner's recorded decision to prepare the harness and run paid measurements later.

## Frozen corpus

`scripts/fixtures/code-map-evaluation/corpus.json` defines 26 tasks: 6 training and 20 held-out evaluation tasks.
Repositories: Oxytocin and the original `modules` and `csharp-solution` fixtures. Every task specifies its prompt,
expected files, acceptance assertions and commands or explicit review checks before any agent runs. Tasks cover
subsystem discovery, callers, API changes, bugs, package orientation, worktrees, simple searches, unsupported languages
and dynamic/unresolved code. Expected negative cases include trivial path/type lookups, lexical shadowing, extension
methods, event subscriptions and the distinction between installed grammars and implemented language support.

The corpus is revision-specific. Before evaluating a later language-support stage, fork/version the corpus and
preregister it again; do not silently change stage 10's unsupported-language answers. Existing behavior tests alone
do not prove an agent completed its task: apply the task's assertions and review its actual patch/answer.

## Offline commands

Run from the repository root (use `npx.cmd` in Windows PowerShell):

```sh
npx tsx scripts/code-map-agent-evaluation.ts validate
npx tsx scripts/code-map-agent-evaluation.ts prepare --config evaluation-config.json --revision <full-stage-10-commit> --seed 10 --repeats 3 --output manifest.json
npx tsx scripts/code-map-agent-evaluation.ts report --manifest manifest.json --results normalized-results.json --output report.json
```

These commands validate/preregister/analyze files only. They never start a CLI, create worktrees, call a provider or
run arbitrary acceptance commands. Output uses exclusive creation and never overwrites a previous report. Archive
the corpus, manifest, settings and raw artifacts before running sessions. `EvaluationConfigSchema` and
`EvaluationResultSchema` in `scripts/lib/code-map-evaluation.ts` define the machine-readable inputs.

Configuration must record agent and model names **and versions**, complete settings, provider, captured pricing date
and source, USD-per-million uncached-input/cached-input/output rates, timeout and the preregistered acceptable median
time regression (default 10%, can only be tightened). Enter actual recorded rates; this report invents none.
Providers with additional cache-write or other billing categories require an explicit normalization/extra cost
report; the three-category estimate must not be presented as the whole invoice.

## Execution protocol for the owner

1. Pin all sources to the manifest revision. Initialize each standalone fixture as its own Git repository from
   that revision's fixture directory. Keep the reference expectations and acceptance checks outside agent context.
2. Each scheduled job has a unique checkout/session path. Materialize a fresh detached checkout and independent agent
   session for every job, with no transcript or patch carried from another attempt. Run in the manifest's seeded
   randomized block order, including the randomized on/off order within each task/repetition. Default: 156 sessions,
   of which 120 are held-out. Use training tasks only for prompt/budget tuning; refreeze before held-out runs.
3. Keep agent/model/version/settings and repository instructions identical within a pair. Record their instruction
   hash. The only treatment is Code Map availability and its measured brief/tool schemas. Never inject expected-file
   lists, reference answers or acceptance commands into the task prompt. Record normal tool availability separately.
4. The `first` phase (repetition 1) starts without an index. The `repeated` phase (repetitions 2+) still uses fresh
   independent checkouts/sessions but prepares an index of that exact snapshot first. Record that setup cost too;
   do not hide it in claimed savings. Baseline jobs get equivalent filesystem-cache preparation. Record first-task
   end-to-end time including setup and warm-task time separately; compare only the paired phase. No reused agent
   memory is allowed. This phase convention is preregistered, not inferred from execution order.
5. For worktree tasks, prepare the same task/base/change in both arms before starting the agent. Obtain the map for
   that registered checkout, never the main checkout. Start every attempt from the same fixture state.
6. Retain failed sessions and timeouts. Apply the frozen acceptance assertions and checks, record a human review,
   regression count and an acceptance-log path. Failed/timed-out sessions cannot be marked accepted. Fixture
   modification checks require an isolated TS/.NET evaluator selected and frozen before the paid run; this harness
   does not install or run compilers. Do not edit acceptance criteria after seeing an answer.
7. Normalize each session into the result schema and retain raw provider/CLI logs. Use `null` for unavailable metrics,
   never zero. Record uncached input, cached input, output, total and exploration tool calls, map queries, duration,
   empty/failed searches, index setup/update work, peak RSS, instruction/schema overhead, fixture recall@8 and relation
   TP/FP/FN. Exploration means discovery/list/search/read/outline/relations, excluding edit/test/commit operations;
   freeze the CLI-specific tool-name mapping before the run.
8. Record usage boundaries. Usage Monitor aggregates account/project sessions and is not itself a paired-task meter;
   a cache hit, retries and resumed/subagent sessions must be reconciled with raw CLI/provider records. Include the
   entire task and map instruction/schema overhead. Unreturned characters are never treated as saved tokens.

## Analysis and gates

The reporter validates manifest/corpus/configuration hashes, pinned revisions, unique sessions/checkouts, duplicate results and
unchanged instruction hashes within pairs. It excludes training tasks from the gate and reports paired raw results,
cost estimates, min/p25/median/p75/max, first/warm distributions, failures/timeouts and every task with an observed
increase in time, uncached input, exploration calls or correctness regressions. Missing jobs/measurements cannot be
silently discarded. Unknown metrics stay unknown. Raw result records preserve all additional overhead and accuracy
fields for review; report precision as TP/(TP+FP), recall as TP/(TP+FN), and undefined denominators as unknown.

Gate: at least 15% lower median uncached input **or** exploration calls, no paired correctness regression or additional
test regressions, and median time within the preregistered tolerance. This is directional evidence, not a statistical
guarantee. All held-out jobs must be present; if neither benefit metric is complete the result stays `unverified`.
Both arms failing is retained and must be discussed rather than interpreted as evidence of correctness.
If no baseline task passes acceptance, the benefit gate remains unverified.

Current results: **0 sessions; no measurements; gate unverified**. Synthetic unit tests exercise the analyzer's pass,
failure, timeout, missing-metric and metadata rejection paths; their numbers are test data, not agent outcomes.
Automatic learnings remains unavailable until the later longitudinal gate is actually measured.
