# Learning visualization and longitudinal evaluation

Date: 2026-10-20. Implementation base: `423ee64`; the stage 14 commit freezes the final corpus and harness.
Scope follows the owner's existing decision: prepare the offline corpus/harness and defer paid model sessions.
**No agent/model evaluations were run. Review and Automatic have no measured benefit result. Automatic remains unavailable.**

## Product behavior

Plugin API 0.2.1 adds `code-map.knowledge.read`. Both this permission and `code-map.read` are required for knowledge
and receipt slices. Facade and main enforce permission before dispatch and after completion; main cancels knowledge
requests on revocation. Structural APIs and events contain no learning labels/counts. Knowledge invalidations are
targeted separately. The built-in visualizer uses the public API and no direct store access.

Knowledge defaults to applicable reviewed findings, with explicit pending/stale/all inspection filters. Complete
learning bodies, recorded evidence hashes, origin, revision and applicability are visible in details. Logical evidence
and lifecycle relationships never become structural dependencies. Reviewed, proposed, stale and imported automatic
records have different shapes and text labels. Imported automatic admission is quarantined from Review retrieval
until explicit user review. Evidence freshness does not establish semantic truth.

Task context uses `oxytocin.codeMap.openReceipt({ projectId, checkoutId, receipt })`, also available through its form.
It reconstructs selected IDs/revisions/reasons only, without the original question. Its generation and memory revision
must remain available. Expiry, revocation, Off mode, forget, changed evidence or removed checkouts clear access; no
current context silently replaces the named receipt. The UI clears the display at its 30-minute expiry even without
another request. `oxytocin.codeMap.openLearnings(projectId)` opens the core manager.

## Frozen experiment

Corpus: `scripts/fixtures/code-map-learning-evaluation/corpus.ts`. Ten distinct protocols: zero sentinel, tenant keys,
timeout units, chunked line decoding, retry method whitelist, case-sensitive paths, versioned entity identity, async
results, case-insensitive header names, decimal money scale. Each sequence has four independent sessions:

1. Discover a non-obvious constraint and implement a consumer.
2. Implement a related consumer, reusing only this run's generated memory.
3. Apply the frozen source mutation and implement the follow-up against the current protocol.
4. Implement an unrelated local utility as a retrieval negative control.

References, test cases, mutations and session prompts are fixed before execution and hashed with the manifest. The
same initial protocol, instructions and task skeletons are materialized for every arm. References, session packets
and false/wrong-checkout challenge candidates stay outside the agent checkout. The evaluator must enforce that
filesystem boundary: a prompt instruction is not a sandbox. Run untrusted submitted modules inside a disposable
container with only their checkout mounted; the harness's verifier is a child process, not a security sandbox.

Four arms: baseline ordinary tools, A structural tools, B-review structural tools plus user-reviewed memory, B-auto
structural tools plus an isolated evaluation-only admission adapter. Three repeats by default: **120 isolated runs,
480 independent client sessions**. Seeded random arm order is frozen per sequence/repeat. Every run has its own
checkout and memory path; later sessions preserve only that run's generated findings, never transcripts, reference
answers or another arm's corrections. No account-level memory or resumable client state is allowed.

The B-auto adapter is an evaluator integration, not a hidden product mode. Freeze its version in config settings,
and retain its artifact. Policy `evidence-current-nonconflicting-constraints-v1`: admit only constraint candidates with
at least one independently re-read permitted evidence file whose recorded hash matches, valid anchors, no conflicts
or replacement cycle, correct checkout and remaining project budget. Other candidates remain pending. No semantic
truth claim follows from admission. Do not impersonate user review through the product API. The runner/adapter and
actual paid measurements remain the evaluator's work; these offline commands never start them.

After discovery, inject the frozen false and wrong-checkout challenge candidates through the isolated evaluator
adapter, with distinct challenge provenance. Record proposals/admission/emissions/use and human corrections. Keep
challenge counts separate from organic findings when analyzing capture quality; include any harmful use in the gate.
Review uses an actual human decision and measured minutes. In all arms retain ordinary tools and identical client,
model, versions, settings and source state; treatment changes only structural/memory capability.

## Offline commands

Run from the repository root (`npx.cmd` on Windows):

```sh
npx tsx scripts/code-map-learning-evaluation.ts validate
npx tsx scripts/code-map-learning-evaluation.ts prepare --config evaluation-config.json --revision <full-commit> --seed 14 --repeats 3 --output /new/experiment
npx tsx scripts/code-map-learning-evaluation.ts verify --manifest /new/experiment/manifest.json --run zero-sentinel-1-A --session discover --output discovery-validation.json
npx tsx scripts/code-map-learning-evaluation.ts mutate --manifest /new/experiment/manifest.json --run zero-sentinel-1-A
npx tsx scripts/code-map-learning-evaluation.ts verify --manifest /new/experiment/manifest.json --run zero-sentinel-1-A --session mutated --output mutation-validation.json
npx tsx scripts/code-map-learning-evaluation.ts report --manifest /new/experiment/manifest.json --results normalized-results.json --deterministic deterministic-results.json --output report.json
```

Preparation exclusively creates a new directory; reuse fails. Mutation is a one-time operation before session three;
it changes only the protocol and preserves generated memory. `verify` runs the frozen external acceptance cases with
a timeout and hidden Windows child, records pass/fail, and never writes reference tests into the checkout. Use the
correct session packet; complete sessions in order. Keep the evaluator source pinned to the manifest revision.

Configuration reuses `EvaluationConfigSchema` from stage 10: exact client/model/version/settings/provider, actual
captured pricing source/date/rates and timeout. Include the structural/memory tool schema hashes, instruction hash,
adapter version and the CLI-specific exploration-call classification in `settings` before freezing. No rates are
invented. Normalize raw per-session usage into `LearningSessionResultSchema` in
`scripts/lib/code-map-learning-evaluation.ts`; use null for unavailable data and retain the artifact paths.

## Measurements, rubric and release gates

Each independent session records correctness against external cases, repeated errors, harmful false claims, real
uncached/cached input and output tokens, measured total and exploration USD cost with billing/log source, duration,
peak RSS, proposals/rejections/duplicates, emitted/useful findings, relevant available/retrieved findings, wrong-scope
and invalidated uses, correction minutes and human review minutes. Retain raw provider usage, validation, rubric,
isolation and B-auto-policy artifacts. Retries and cache writes belong in the complete billed total. Characters/4,
use counts and reduced prompt lengths are never cost savings. Do not enter zero for missing metrics.

Before running, reviewers apply this rubric to every emitted finding: relevant to this session's task, actionable
without inventing a rule, correct scope, evidence still current, no conflict with project instructions. Useful means
all five pass. Separately assess semantic correctness and harmful claims; usefulness is not truth. Recall denominator
is the independently reviewed relevant set available before retrieval. Repeated errors repeat an already-observed
protocol violation in a later related session. Report unrelated retrievals and challenge emissions separately in the
rubric artifact. Record first-session capture/setup cost separately, compare it with paired A, and report whole-sequence
cost and review/correction minutes so any benefit is amortized across the complete sequence.

The reporter rejects changed manifests/corpora, cross-run checkout/memory/session identities and duplicate results.
Missing sessions/metrics/artifacts make gates unmeasured. Review and Automatic get separate gates: deterministic
wrong-checkout and known-invalidated retrieval counts must be zero, no paired correctness regression against A,
at least 80% usefulness precision, no harmful claims, and either a 10% lower median related exploration cost or fewer
repeated errors with measured whole-sequence/review/correction costs. The optional deterministic artifact is
`{ "wrongScopeUses": 0, "invalidatedUses": 0, "artifact": "path/to/real-test-log" }`; omitted evidence cannot pass.
All paired sessions where memory raises cost or worsens correctness are listed explicitly, alongside harmful claims.
Passing this offline reporter never toggles a product mode; an actual release decision requires reviewing real data.

| Arm | Model sessions | Benefit/correctness result | Release gate |
| --- | --- | --- | --- |
| Baseline | 0 | Unmeasured | Comparison absent |
| A | 0 | Unmeasured | Comparison absent |
| B-review | 0 | Unmeasured | Unverified |
| B-auto | 0 | Unmeasured | Unverified; unavailable in product |

No measured harmful/worse cases exist because no model sessions ran. This is missing evidence, not a finding of zero
harm. If Automatic fails, revise its admission policy and repeat on new uncontaminated fixtures before offering it.

## Validation

Offline smoke prepared all 120 runs and 480 packets outside the repository. An unimplemented consumer failed frozen
acceptance, a protocol-preserving consumer passed, the one-time mutation applied, and the follow-up passed its changed
cases. Reporting an empty result set produced 480 missing sessions and unmeasured gates for both memory arms. These
are harness checks with synthetic code, not agent results or benefit measurements.

Linux validation in `oxy-code-map-work`: 60 host memory/lifecycle, permission and evaluation tests passed. The app,
SDK and built-in plugins built, then **16/16 Electron E2E passed under Xvfb**, including Knowledge Off/pending/active/stale,
opening a receipt through the core-command bridge, browser expiry, generation mismatch, removed Ensemble checkout,
structural-only fixture permission denial and the existing map/language/manager/MCP flows. No desktop windows opened.
The plugin host's two focused routing/invalidation tests also pass after updating their API mocks.

Windows `npm run check` passed: typecheck, ESLint/Prettier, **1,431 unit tests** (6 skips), **70 integration tests**
(66 platform/resource skips), **3 latency tests**, and the production license allowlist. `git diff --check` passed.

Logs (ignored): `test-results/code-map-stage14-check.log`, `code-map-stage14-plugin.log`; container logs:
`/tmp/code-map-stage14-memory.log`, `/tmp/code-map-stage14-final-e2e.log`. Existing packaged large-checkout memory,
production accessibility/terminal latency and manual external-client release gates remain open; this stage makes no
new performance or savings claim.
