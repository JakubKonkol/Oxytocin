# Code Map validation

The runtime feature has not been implemented or benchmarked. All thresholds below are proposed engineering targets; replace them with measured results during implementation.

The structural matrix and first-release checklist apply to A. Additional sections below define B (self-learning context) and C (visualizer); A passing alone does not validate the whole proposed product.

## Correctness and recovery matrix

| Scenario                                                      | Required outcome                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Initial enable, restart, disable                              | Disabled by default; enabled map builds; restart reconciles; disable releases work and denies reads.                         |
| Settings saved through another tab                            | Code Map settings are preserved, including exclusions. Old project files load without migration errors.                      |
| Edit, atomic save, untracked creation, deletion, rename       | Incremental graph equals a cold graph of the same final files; obsolete nodes/edges disappear.                               |
| Import/export or tsconfig/package resolution change           | Relations are recomputed, including unchanged callers; unsupported resolution remains explicit.                              |
| Shadowed/same-named functions, computed calls                 | No fabricated cross-file caller; unresolved coverage is visible.                                                             |
| Unicode, CRLF, BOM, case-sensitive paths                      | Returned spans identify exact source text; canonical paths do not merge distinct files.                                      |
| Parse error during typing                                     | Partial/error coverage is exposed; previous syntax is never silently reported as fresh.                                      |
| Same-size edit with restored mtime, deliberately missed event | Verified mode/full hash audit detects it. Metadata mode states its verification limitation.                                  |
| Branch switch or Git reset/stash                              | Working-tree reconciliation updates the graph, including previously untracked/removed files.                                 |
| Non-Git folder; Git UI disabled                               | Mapping still watches and queries supported source files.                                                                    |
| Concurrent edits and 10 simultaneous queries                  | One shared build per checkout, coherent pinned responses, no dropped pending events or build stampede.                       |
| Pause, refresh deadline, cancellation                         | Latest reads do not silently return stale data; explicit stale reads carry metadata; cancelling one caller preserves others. |
| Kill host during parse or publish; corrupt cache              | Last valid generation remains readable when explicitly allowed; invalid snapshots rebuild; no main-process crash.            |
| Watch overflow, resume after sleep                            | Reconciliation is scheduled and freshness becomes unknown until checked.                                                     |
| Two projects, overlapping roots, two worktrees                | Selection follows explicit checkout context; no active-project fallback or cache cross-contamination.                        |
| Ensemble role revoked/checkout removed                        | Outstanding and later access fails; cannot redirect via supplied selectors.                                                  |
| Excluded files, traversal, junction escape                    | Enumeration and direct tools reject out-of-scope paths; no source leakage through snippets or diagnostics.                   |
| Huge/malformed file or graph                                  | Caps/watchdog prevent uncontrolled growth; coverage and retry/exclusion advice remain usable.                                |
| Client keeps old tools after disable                          | Calls are denied by current state; tool-list availability is not treated as authorization.                                   |
| App closed while files change                                 | Next launch reconciles; no claim of background synchronization while closed.                                                 |

Use original small repositories with expected relations to measure both precision and recall. Assert semantic graph equivalence while excluding generation timestamps. Add regression fixtures for every resolver bug rather than snapshotting the entire implementation output blindly.

## Integration and E2E coverage

Add meaningful tests to existing Vitest projects for extraction, resolution, scheduler races, cache publication, strict checkout selection, and tool budget enforcement. Integration tests should launch the host with real filesystem events and exercise MCP through the existing HTTP transport. Include a malformed IPC/RPC/file payload test at each new boundary.

Add `tests/e2e/code-map.spec.ts` for project enable → ready → agent query → edit → updated result → disable, using isolated fixtures and a deterministic fake agent/MCP client. Extend existing settings and Ensemble suites for preference round-tripping and actual worktree selection. Do not require a paid model in CI.

Run `npm run check`, `npm run build`, the new suite and affected `project-settings`, `mcp-hub`, `ensemble`, and `ipc-hosts` suites. Add a packaged Windows smoke test verifying bundled grammars, offline operation, paths with spaces/non-ASCII characters, and startup without a system compiler. Exercise macOS/Linux on their supported CI environments before declaring cross-platform support.

## Performance experiment

Record hardware, Windows/Electron/Node versions, exact grammar versions, repository revision, file/byte/node counts, warm/cold filesystem cache, active terminals, and Git workload. Use both Oxytocin itself and a reproducible 10,000-source-file fixture. Add a near-limit fixture to verify graceful failure rather than promise interactive speed at the cap.

| Metric                                      | Initial target on a documented Windows development machine                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Cold index, 10,000 source files             | Under 30 s, with progressive status and cancellation.                                       |
| Saved one-file edit to queryable generation | p95 under 2 s after the last event on the 10,000-file fixture.                              |
| Warm bounded search/traversal               | p95 under 200 ms excluding a required refresh; report probe and retrieval costs separately. |
| Refresh wait                                | At most 2 s before an explicit updating/stale outcome.                                      |
| Host resident memory                        | Under 512 MiB on the 10,000-file fixture; record peak and retained memory.                  |
| Idle resource use                           | No rebuild loop; under 1% of one core averaged over five minutes, including periodic scans. |
| Terminal/Git responsiveness                 | No more than 10% p95 regression versus a controlled baseline under the same workload.       |

Run each performance case repeatedly and report median/p95 and peak memory, not only a favorable run. Measure serialization, file reads, grammar warmup, resolution, and scan overhead separately. If a target fails, profile and adjust architecture or documented limits before release; do not silently weaken correctness to meet latency.

## Does it actually help agents?

Use a fixed corpus of at least 20 repository tasks: locate a subsystem, trace a caller, change an API, fix a bug, inspect an unfamiliar package, and update a worktree. Include tasks where plain search is already sufficient and tasks involving unsupported/dynamic code. Define expected files and acceptance tests before running agents.

Compare the same agent/model/version/settings with mapping disabled and enabled. Randomize order, use fresh checkouts and independent sessions, repeat each task at least three times, and record failures/timeouts rather than dropping them. Keep repository instructions constant except for the measured map brief. Evaluate:

- Correctness/task completion and regressions, judged by predetermined tests and review.
- Total input/output tokens, cache-hit distinctions, cost at the recorded provider rates, tool calls, elapsed time, and map-query count.
- Index setup cost, update work, memory, instructions/tool-schema overhead, and failed or empty retrievals.
- Retrieval recall@8 against expected files and relation precision/recall on labeled fixtures.
- Cold first task separately from repeated tasks where setup is amortized.

Suggested benefit gate: at least 15% lower median uncached input tokens or exploration tool calls, with no observed correctness regression and no material median task-time regression. This small sample is directional evidence, not a statistical guarantee. Report dispersion, paired results, and tasks harmed by mapping; expand the sample before making marketing claims. Use Usage Monitor where it exposes the necessary fields, but verify measurement boundaries and keep external agent-run logs when needed. Never equate “characters not returned” with actual billed tokens saved.

## Milestone A acceptance checklist

- [ ] Project opt-in, settings persistence, status, exclusion controls, rebuild/pause/clear/disable work.
- [ ] JS/TS coverage and unresolved cases are documented; source spans are correct.
- [ ] Saved changes are indexed automatically; query freshness and stale/error paths are explicit.
- [ ] All four bounded tools work through the existing Hub; agents have concise discovery guidance.
- [ ] Ensemble queries its authenticated checkout; no cross-worktree fallback.
- [ ] App restart/crash/cache corruption recovery and resource limits pass.
- [ ] Packaged Windows operation is offline and requires no additional toolchain.
- [ ] No repository setup files or source files are changed by enabling/indexing/querying.
- [ ] License notices, relevant tests, build/start checks, and measured performance results are recorded.
- [ ] Agent outcome evaluation is recorded; benefits are described only to the extent supported by results.

## Learning correctness and recovery (milestone B)

| Scenario                                                         | Required outcome                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory absent/off; switch automatic → review → off               | Missing means off; writes/read reuse respect current mode; unreviewed auto-admitted entries stop appearing in review mode; disabling does not erase durable knowledge.             |
| Same proposal retried, two agents correcting one entry           | Idempotent retry returns the same result; expected-revision conflict prevents silent overwrite and duplicate corroboration.                                                        |
| Evidence hash supplied by agent differs from disk                | Service computes/verifies its own evidence; changed-during-read returns an explicit error.                                                                                         |
| Evidence is unchanged but claim is incorrect                     | Origin/admission remains distinguishable from truth; a test must not assert correctness just because hashes match.                                                                 |
| Evidence file/config changes while structural rebuild runs       | Affected applicability is invalidated before a latest context response can reuse the entry.                                                                                        |
| Rename/delete, same-named symbol, rollback to older branch       | No guessed reattachment; old claims do not become active through name matching or timestamps. Revalidation is explicit.                                                            |
| Contradictory records / explicit supersession                    | Known conflicts are excluded until resolved; an unreviewed replacement cannot silently supersede a reviewed entry. Unknown semantic contradictions remain a documented limitation. |
| Useful/irrelevant feedback repeated or forged                    | Counts are bounded/deduplicated; missing/expired/cross-checkout receipts are rejected; popularity never converts a claim into verified evidence.                                   |
| Generic Hub caller claims another author/role                    | Origin records the actual available authentication context; supplied identity/test success remains unverified metadata.                                                            |
| Ensemble role revoked; worktree removed or merged                | Writes/reads stop at revocation; knowledge is not automatically promoted into another checkout after merge/removal.                                                                |
| A project-scoped entry matches one worktree but not another      | Applicability is evaluated independently; no leakage of an unmerged decision as an applicable fact.                                                                                |
| Clear index cache, grammar upgrade, corrupt structural snapshot  | Durable learnings survive; their anchors are rechecked against rebuilt data.                                                                                                       |
| Kill host during durable mutation/migration; malformed memory    | Atomic recovery preserves prior knowledge; incompatible memory is not discarded as cache.                                                                                          |
| Forget/delete followed by restart, export, and cache rebuild     | Stored recovery copies/indexes cannot resurrect deleted bodies; external prior exports are outside deletion guarantees.                                                            |
| Secret-path reference, excluded document, prompt-injection prose | Reference rejected where excluded; no tool execution, rule installation, credential read, or automatic external fetch from memory contents.                                        |
| Unanchored entry or out-of-scope URL                             | No automatic activation; user-reviewed unanchored entries have an expiry; URL content is not implicitly trusted/fetched.                                                           |
| Very large proposal/store/feedback stream                        | Explicit caps and rate limits prevent growth; writes fail recoverably without breaking existing reads.                                                                             |
| Paused index or unavailable current generation                   | No automatic admission requiring fresh evidence; explicitly stale reads carry checkpoint status.                                                                                   |
| Memory disabled/unavailable during context assembly              | Code-only result identifies memory state; no concealed empty-memory claim and no loss of structural access.                                                                        |

Use fixtures for admission, evidence races, conflict/revision handling, and prompt-like data. Do not test semantic truth with implementation-shaped assertions such as “active means correct.” Include deliberately plausible but false claims in manual/agent evaluation.

## Longitudinal learning evaluation

Use at least ten task sequences, with three or more separate sessions per sequence: discover a non-obvious constraint, solve a related task, then change the relevant code/configuration and solve a follow-up. Include unrelated later tasks and incorrect memories, not only favorable reuse examples. Fix reference answers, scope, and validation tests before running.

Compare paired arms under the same client/model/settings:

| Arm      | Enabled behavior                                      | What it isolates                                     |
| -------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Baseline | Ordinary tools and unchanged repository instructions. | Existing agent performance.                          |
| A        | Structural graph tools only.                          | Index/retrieval benefit without memory.              |
| B-review | A plus user-reviewed learnings.                       | Reuse benefit and human review workload.             |
| B-auto   | A plus automatic admission of eligible proposals.     | Capture/admission quality and fully automatic reuse. |

Use at least three repeats per sequence/arm, fresh isolated stores per run, randomized arm order, and the same starting repository state. A later session may use only learnings actually generated in preceding sessions of that run. No reference solutions, future task descriptions, or reviewer corrections from another arm may enter memory. Report first-session capture overhead separately and amortized across the full sequence. Tune ranking/admission on different fixtures from the held-out sequences.

Measure task success, repeated mistakes, actual input/output/cache tokens, latency, storage, proposal counts, proposal rejection/duplication, useful learning precision, retrieval recall, wrong-scope/stale reuse, correction time, and human review minutes. Report the source of every cost metric and missing data. Reuse count and `characters / 4` are not monetary/token savings.

Initial B release gates: zero wrong-checkout or known-invalidated entries in deterministic retrieval tests; no observed task-correctness regression against A in the evaluated sequences; at least 80% of emitted learnings judged relevant and useful by the predefined rubric; and either 10% lower median exploration cost on related follow-up tasks or a documented reduction in recurring errors, with whole-sequence costs and review time reported. These are proposed directional gates, not statistical guarantees. Distinguish relevance from factual correctness; report harmful false statements separately even if they were topically relevant.

Always publish cases where memory increased cost or caused errors. If automatic admission fails, improve/constrain it and repeat the affected held-out evaluation with new uncontaminated fixtures. Do not hide failures behind a favorable pooled average or market reviewed memory results as evidence for automatic mode.

## Visualizer and public API validation (milestone C)

Test the new public API with authorized and unauthorized fixture plugins, including a plugin with structural read permission but no knowledge permission. Ensure mixed projections do not leak knowledge through labels/counts when permission is absent. Test revocation/disable with an outstanding request, cancellation and stale generation errors, late view replies, root containment, and source-column conversion. New permissions constrain API calls; tests must not claim they sandbox arbitrary Node plugin code.

The same fixture slice queried through core/MCP and plugin projections must agree on node identity, relationships, provenance, and coverage, after accounting for their different budgets. Aggregated edges must equal the counted underlying relations in the selected scope. Include cyclic graphs, high-degree hubs, unsupported files, unresolved imports, and knowledge linked to deleted symbols.

E2E: enable project → open visualizer → choose checkout → search/expand → inspect evidence → open source → save an edit → refresh → switch project rapidly → hide/show panel → disable plugin → verify MCP still answers. Repeat with B off, pending/active/stale knowledge, and a removed Ensemble checkout. Verify keyboard-only list navigation and that style differences are not color-only.

Run the [renderer experiment](visualizer.md#rendering-decision-and-experiment) in a packaged Windows build offline, at default and hard slice limits. Record transferred bytes, layout time, interaction p95, memory retained after disposal, and terminal p95. Test graphics initialization failure with a usable list fallback. No background layout when hidden and no retained subscriptions after disposal.

## Milestone B and C acceptance checklists

B:

- [ ] Memory mode, manager, proposals, reviews, automatic eligibility, evidence, corrections, scope promotion, export, and deletion work without the plugin.
- [ ] All three B tools validate both sides of the boundary, obey budgets/policies, and bind to the proper checkout.
- [ ] A later independent session reuses applicable knowledge; changed evidence prevents stale reuse.
- [ ] Durable migration/crash recovery, revision conflicts, worktree isolation, and forget semantics pass.
- [ ] No transcript collection, automatic repository edits, or background provider calls occur.
- [ ] Review and automatic modes have separate longitudinal results including capture overhead and harmful cases.

C:

- [ ] Public plugin API/version, capability checks, permissions, source navigation, and invalidation delivery are documented/tested.
- [ ] Overview and Neighborhood are complete; Knowledge/Task context overlays are available only with B capabilities.
- [ ] All views obey node/edge/byte caps and identify checkout, generation, coverage, and omissions.
- [ ] Disable/dispose and rapid context changes are correct; agents work when the plugin is absent.
- [ ] Keyboard/list alternative and packaged offline renderer checks pass.
- [ ] Renderer dependencies/licenses and measured performance/terminal impact are recorded.
