# Code Map validation

The runtime feature has not been implemented or benchmarked. All thresholds below are proposed engineering targets; replace them with measured results during implementation.

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

## First-release acceptance checklist

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
