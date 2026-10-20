# Code Map implementation status

Updated: 2026-10-20. Stage 10 base revision: `6b7b5de`. Working branch: `main`.

## Current work

- Stage 00 complete: reproducible parser and Windows ASAR packaging benchmark, grammar integrity manifest and deterministic 10,000-file fixture. Decision: Tree-sitter WASM, lazy grammars, explicit CommonJS runtime entry.
- Stage 01 complete: contracts, lazy host supervision and build assets, safe storage and Git ignores.
- Stage 02 complete: enumeration, live observation, fingerprints, global scheduling and activity hints.
- Stage 03 complete: isolated parser with watchdog, syntax records, lexical/module resolution, deterministic graph, incremental cache and bounded MAP.md publication. See results/2026-10-19-typescript-graph.md for measured fixture accuracy and deliberate resolution limits.
- Stage 04 implementation complete: main service, validated renderer IPC, Project settings UI and reproducible packaged full-index benchmark. Release-validation gates remain open (see below).
- Stage 05 complete (C#): projects/solutions, namespaces, partial types, using directives, declared-type calls, MAP.md .NET section. Measured on Linux; see results/2026-10-20-csharp.md. Performance targets are not met.
- Optimization pass after stage 05 complete (path-limited watcher updates, compressed in-memory-indexed cache, single serialization); see results/2026-10-20-optimization.md.
- Stage 06 implemented (`92ee704`): bounded host queries, freshness barriers and five read-only MCP tools. Small-fixture warm HTTP p95 71.28 ms. App E2E passes; manual CLI validation remains open. See results/2026-10-20-mcp-tools.md for the original measurements.
- Stage 07 implemented (`f8fec0a`): isolated worktree registrations, role-authenticated MCP bridge, explicit instruction-file blocks and `.oxy` exclusions from Ensemble diffs/checkpoints. See results/2026-10-20-worktrees-instructions.md.
- Stage 08 implemented (`6e20c52`): Plugin API 0.2.0, bounded slices, permission checks, cancellation, invalidations and verified worktree-aware source navigation. Full check/build passed.
- Stages 05–08 verified on Linux after the stage 09 handoff: app E2E for stages 06–09 now passes; fixes and remaining findings are under "Verification of stages 05–08".
- Stage 09 implemented: built-in visualizer, local Cytoscape renderer, keyboard list, settings/menu entry points and reproducible Chromium iframe measurements/smoke. App E2E now passes; terminal-regression measurements remain open.
- Stage 10 implemented: host-owned impact/dependents, Changes and Impact views, strict checkout selection, authorized worktree/base Git comparison and verified source navigation. Export deliberately deferred. Offline evaluation corpus/harness prepared (26 tasks, 20 held-out); no paid sessions, benefit gate unverified. See `results/2026-10-20-insights.md` and `results/2026-10-20-agent-evaluation.md`.
- Stages 11–14 are not implemented. Resume at stage 11a (Go), then 11b Java, 11c Python and 12–14, with separate commits and no push.
- Read `README.md`, the current stage document and this file before continuing. Follow the dependency order; do not mark measurement gates complete without recorded results.

## Environment and validation

- Stage 10 environment: Windows, Node 24.11.1; Docker Desktop is running (the user confirmed availability). The
  existing `oxy-code-map-work` container uses Linux Node 24.21.0 and `oxy-e2e:latest`. Electron E2E runs under Xvfb;
  never open desktop Electron windows. Playwright Chromium Headless Shell is installed for standalone iframe checks.
- For source sync, exclude the root dependency/build directories, but explicitly copy the tracked fake CLIs under
  `tests/fixtures/agents/node_modules/`; a blanket `--exclude=node_modules` silently omits them. Linux dependencies
  were refreshed with `npm ci`. The container's PID 1 is `sleep infinity`, so process-tree tests need a child subreaper
  (or a new container with `--init`) to reap killed grandchildren; the stage 10 validation helper is in
  `test-results/code-map-stage10-reaper.py` and `/tmp/code-map-stage10-reaper.py` in the container.
- The following environment notes describe earlier sessions; verify availability rather than assuming those tools
  or containers still exist.

- 2026-10-20 sessions run in a Linux cloud container (no Docker, no Windows): Node 24 installed to `/opt/node24`
  (`export PATH=/opt/node24/bin:$PATH`), Electron binary installed with `node node_modules/electron/install.js`. Run E2E
  with `xvfb-run -a npm run e2e -- <specs>`. The packaged benchmark runs headless on Linux (`--ozone-platform=headless`;
  the script sets `LANG=C.UTF-8` because Chromium cannot start from a non-ASCII path in the C locale). Linux full
  `npm run check` is green here, including the PTY integration test that timed out in Docker earlier.

- Windows, Node 24.11.1; use `npm.cmd` / `npx.cmd` in PowerShell (the execution policy blocks `npm.ps1`).
- Docker Desktop Linux engine is available, including the existing `oxy-e2e:latest` image. Run Electron E2E in Docker under Xvfb; never open desktop windows.
- The reusable `oxy-code-map-work` container is stopped at this checkpoint; `docker start oxy-code-map-work` restores `/work` with Linux dependencies and cached build outputs. `/source` is the read-only Windows workspace mount. Copy source with tar excluding node_modules, .git, test-results, release and out before validating subsequent changes.
- The parser benchmark creates no BrowserWindow. Child processes must use `windowsHide: true`.
- Grammar install scripts are deliberately disabled. Only prebuilt WASM assets are used.

## Stage log

### Stage 00 — parser spike

- Results: `results/2026-10-19-parser-spike.md` and adjacent raw JSON. Packaged fixture: 1.89 s / 159 MiB peak RSS. Cold file I/O was profiled separately; do not claim the full indexer meets NFR-1 yet.
- Windows `npm run check`: passed (1,259 unit tests, 64 integration tests, 3 latency tests; platform/service skips recorded in test output). Focused script tests: 5 passed. Final script typecheck, ESLint and formatting passed.
- Docker build and E2E under Xvfb: `ipc-hosts.spec.ts` and `smoke.spec.ts`, 4 passed. App startup, IPC validation and host restart are verified without desktop windows.
- Additional Linux full check: unit tests passed; integration consistently times out at the existing PTY flow-control test (`tests/integration/pty-host.test.ts:231`). This stage does not change PTY code. Windows full check and Docker E2E are green; retain this limitation when comparing later runs.
- Cross-platform npm lock repair adds missing optional `@emnapi` entries without changing existing versions. Notices regenerated in Linux to preserve existing platform notices.
- Next: stage 01. Wire asset copying into Vite/electron-builder, keep the CommonJS runtime alias from the spike, add shared contracts, supervised lazy host, safe `.oxy` storage and watcher exclusions. The pinned TSX grammar reports syntax errors in two valid repository files; investigate in stage 03 and expose partial coverage.

### Stage 01 — host and storage foundation

- Shared graph/manifest/status/settings/diagnostics schemas and validated checkout RPC. Old projects remain opt-out. Project settings now preserve the optional field at the schema boundary; draft UI preservation belongs to stage 04.
- Lazy supervised Code Map Host (inspect 9235), lowered OS priority, health/restart status, throttled status events. The internal checkout controller deliberately remains paused until scheduling and graph construction arrive in stages 02–03. No UI or indexing is exposed yet; main service lifecycle wiring belongs to stage 04.
- Build verifies and copies WASM to `out/code-map`; electron-builder copies it to external resources. Pass the repository root explicitly to the copy helper from Vite because bundling relocates `import.meta.dirname`.
- Storage: contained real paths, atomic writes with Windows retry, graph-hash validation, bounded cache publication/pruning, old-temp cleanup, heartbeat leases and serialized claims. An extra machine-local `owner.lock.guard/` prevents racing claims. Deletion retires the owned map directory by rename and preserves learnings.
- Git protection preserves BOM/EOL, handles opt-out and removes only the exact generated block; worktrees never edit root ignores. Workspace watcher always excludes `.oxy`, including callback-level filtering.
- Validation: Windows full `npm run check` passed. Linux focused suite: 47 tests passed, including symlink/unwritable-ignore cases. Docker/Xvfb app build plus `ipc-hosts.spec.ts` and `smoke.spec.ts`: 5 tests passed, including actual Code Map Host ping, malformed RPC rejection and restart after a crash. Actual output contains `out/main/codeMapHost.js`, runtime WASM, grammar manifest and C# grammar.
- Upstream release 0.9.10 (`487e7db`) was merged after the first push was rejected; stage 00 commits and the merge are on origin/main.
- Next: stage 02 — enumeration, fingerprints, watcher and scheduler; then stage 03 — extraction/resolution/publication. There is still no user-facing Code Map feature.

### Stage 02 — enumeration and scheduling

- Git tracked/untracked enumeration stays within the project; non-Git traversal uses pinned MIT `ignore` 7.0.13 with nested rule overrides. Built-in exclusions, user globs, secret-name filtering before reads, binary/size filtering, nested repository boundaries and contained real paths are covered by fixtures.
- Watcher starts before scanning and retains events newer than the committed sequence. It excludes `.oxy`, bounds pending path storage, reconciles after errors/overflow and observes Git metadata outside subprojects/worktrees.
- Scheduler allows one build globally; 300 ms quiet / 2 s maximum debounce, 500-path batches promoted to reconciliation, active-project priority with aging, pause/resume/cancellation. Unchanged files reuse fingerprints; rebuild reparses all without losing deleted-file tracking.
- Periodic metadata reconciliation: 60 s for active/terminal projects, 10 min otherwise; full hashes at startup and every 30 min. Main sends compact activity hints and requests audits after focus/resume without starting a disabled host.
- File metadata stays in runtime memory. Reads use bounded buffers and retry stat/content races; no project scripts execute. Parsing and graph publication still belong to stage 03; the current internal controller reports inventory readiness only and has no UI entry point.
- Validation: Windows `npm run check` passed; real watcher integration passed on Windows and Linux. Linux focused unit suite: 53 passed; final bounded-reader regression: 5 passed. Docker/Xvfb full app build and host/smoke E2E: 5 passed. No desktop windows were created.
- Dependency notices regenerated in Docker; retain its optional-package lock entries when later running Windows npm.
- Next: stage 03, using `CheckoutIndexer` hooks to extract only changed files and assemble/publish a fresh graph. Preserve `InventorySnapshot` checkpoints and ownership checks. Investigated spike TSX errors: both involve bare `&` in JSX text; add an explicit regression fixture rather than treating every valid declaration in those files as absent.

### Stage 03 — TypeScript graph and MAP.md

- Tree-sitter runs in one reusable worker thread with a 2.5 s watchdog and memory limits. Grammar hashes are verified; source normalization preserves canonical hashes and UTF-16 positions. Syntax failures retain visibly stale prior declarations.
- Resolution uses lexical scopes, module exports, paths/baseUrl/extends and indexed workspace packages. Unknown receivers remain unresolved; no project scripts or type inference run. Reviewed fixture: imports 2 TP / 0 FP / 0 FN, calls 5 TP / 0 FP / 0 FN; these figures do not claim repository-wide accuracy.
- Graph/cache publication is atomic, bounded and pruned. Cold/incremental/rebuild equality, corruption recovery, privacy, Unicode and Markdown budget are covered. The small fixture has a reviewed MAP.md golden on both platforms.
- Validation: Windows full check passed (1,327 unit tests, 65 integration, 3 latency). Docker focused suite: 57 passed. Docker/Xvfb final host/smoke E2E: 6 passed. No desktop windows.
- Next: stage 04. Keep renderer imports within shared/renderer; initial status and agent instruction text currently live in host and should move to shared. Disabled-data deletion needs an authorized project root RPC without starting an indexer. Performance gates and multi-day dogfooding remain unmeasured; do not claim release readiness.

### Stage 04 — main orchestration and settings UI (`c08d205`)

- Main service owns project authorization, serializes configuration/options/actions/deletion, starts lazily and stops with zero enabled projects. Settings/root/removal changes and host restart reconcile configuration. The existing compact activity-hint service remains separate.
- Shared validated IPC/preload channels expose status, enable/options, rebuild, pause/resume, deletion and bounded diagnostics. Renderer payloads cannot supply arbitrary roots. Host deletion accepts an optional root from main so disabled data can be deleted without starting an indexer or changing Git ignores; repeated deletion is harmless.
- Project settings Code Map commands persist immediately; saving other tabs preserves the latest persisted Code Map settings. Exclusion globs reject traversal/absolute paths. Status, progress, support levels, Git-ignore preference with removal confirmation, diagnostics, agent instructions, built-in MAP.md editor and sidebar status are wired. Background updates do not toast or focus anything.
- Initial status and instructions now live in shared. Parser/cache/graph artifacts remain host-owned. A cold build skips per-file probes when no extraction cache directory exists; corrupt/missing records are still reparsed even if the graph validates.
- Windows full check passed (1,331 unit, 65 integration, 3 latency tests; `test-results/code-map-stage04-complete-check.log`). Supplemental reader-status/cache-recovery regressions: 5 tests passed on both Windows and Linux. Docker focused host/service suite passed (57 before the reader addition); full app build and 10 E2E tests passed. Final extended UI E2E also passed all 3 cases, including opening MAP.md in the built-in editor and displaying diagnostics. All app E2E ran in Docker/Xvfb.
- Packaged Windows full-index benchmark completed headlessly from `scripts/code-map-benchmark.ts`, using the actual controller, worker, grammars and native watcher, empty compiler PATH and blocked utility sockets/fetch. Results and raw machine/run data are committed as `results/2026-10-19-phase-1.md` / `.json`. The benchmark baseline predates the cold-cache probe optimization; do not claim its effect has been measured.
- 10k fixture: empty-map median 37.56 s, edit p95 4.94 s, peak RSS 1,453.90 MiB, five-minute inactive idle 0.291% of a core with no generation loop. Oxytocin snapshot: build median 7.58 s, edit p95 1.52 s, peak 899.85 MiB, known 2 TSX recovery failures. Disk ratios are 28.80× / 9.31× source size, below the hard cap but far above the 5% aspiration. Throughput/memory/disk targets are not met; the report lists phase timings and optimization targets.
- Continue with stage 05 (`etap-05-csharp.md`) when the user resumes. First address/retain the open release gates: optimize and repeat the large-fixture profile, active-checkout idle scans, controlled terminal/Git p95 comparison, actual production-installer smoke, hosted Windows CI and multi-day dogfooding. The packaged benchmark harness passes offline; it does not replace a full installer smoke. No production release was published. Do not mark these gates complete or claim release readiness/token savings.

### Stage 05 — C#

- Extractor `extract/csharp.ts` (declarations with visibility, overload/arity IDs, usings, bases, declared types of
  members/locals/parameters, call intents with receivers and argument counts), `.csproj`/`.sln`/`.slnx`/
  `Directory.Build.props` as data (`resolve/dotnet-projects.ts`), resolver `resolve/csharp.ts` (C# lookup order, partial
  merge, project visibility, overloads by argument count, file→file `references`). Graph schema stays v1 with optional
  fields only; record format version 2 invalidates old caches. Decisions are listed at the end of `etap-05-csharp.md`.
- `bin/`/`obj/` skipped next to .NET project files; C# test projects mark their files as tests; UI shows the C# level and
  its limitations; MAP.md has a `.NET projects` section and C# entry points.
- Validation (Linux): `npm run check` green (1,343 unit, 71 integration, 3 latency tests); E2E code-map/ipc-hosts/smoke
  10/10 under Xvfb, including the new C# solution test. Reviewed fixture: calls 19/0/0, inheritance 2/0/0, project
  references 2/0/0 (TP/FP/FN). Packaged Linux benchmark (1 run): C# 10k cold 57.4 s, edit p95 19.0 s, peak 2.3 GiB, map
  data 46× source; TS 10k cold 41.2 s, edit p95 10.8 s.
- Not done: Windows determinism run (no Windows machine in this session).
- Committed as `82e37a5`.

### Optimization pass (after stage 05)

- Watcher-only batches enumerate only their paths and merge into the inventory with complete skip/failure maps (equal
  to a full scan; tested with and without Git). Directories, `.gitignore` and `.*proj` changes still reconcile fully.
- Cache records are `<key>.json.gz`, written without fsync, size-indexed in memory (`CacheStore`), legacy `.json`
  records removed on load. Graph text/hash computed once per publication; post-assembly zod validation removed (tests
  assert conformance; readers validate). Edge de-duplication uses a field key.
- Packaged Linux benchmark: TS 10k cold 31–33 s, edit p95 4.4 s (was 10.8 s), map 71 MiB (was 133), idle 0.64 % CPU;
  C# 10k cold 45–54 s, edit p95 12.4 s (was 19.0 s), map 126 MiB (was 271). NFR-1/2/5/6 still not met — see the
  report for the next targets (whole-graph re-resolution per edit, C# resolver cost, `graph.json` size, memory).
- Validation: `npm run check` green (1,346 unit, 71 integration, 3 latency); E2E code-map/ipc-hosts/smoke 10/10.

### Verification of stages 05–08 (Linux, after the stage 09 handoff)

- Code review of stages 05–08 against their stage documents. All tasks are implemented. Deliberate deviations stay
  recorded in the stage documents (no source snippets in MCP answers, `generation` is a number).
- First Linux/Xvfb run of the app E2E added in stages 06–09: 18 of 20 passed. Two tests were wrong and are fixed. The
  MCP case expected `isError` after disabling, but the tool is already removed from the list, so the call fails as an
  unknown tool. The visualizer case clicked inside the iframe after the source tab had covered it.
- Fixed:
  - Opening a file in an Ensemble worktree failed when Code Map was off, because editor routing asked the opt-in
    checked `checkoutRoot`. It now uses the worktree registration.
  - A worktree removed while its Code Map registration waited in the queue was registered anyway.
  - Code Map failures no longer fail a task's preparation, deletion or finish.
  - Ensemble checkpoint commits excluded `.oxy` only below the project's subfolder (missing `top` pathspec magic).
  - Agents get the real message for invalid arguments and selectors instead of a generic failure.
  - Adding the instruction block refuses files that are not UTF-8 instead of rewriting them lossily, and keeps the
    file's permissions.
  - C# project references and solution entries match a project file that differs only in case (MSBuild on Windows).
    Enum members inside `#if`/`#elif`/`#else` are indexed. Extractor version 3 reparses older cache records.
  - Plugin docs: Code Map section moved under Reference, permission and namespace rows added, examples and the
    changelogs say that `^0.1.x` manifests no longer load.
- Known and not fixed (recorded for later stages):
  - C#: `ref`/`out`/`in` modifiers are not part of overload IDs.
  - C#: MSBuild `Condition` values containing `>` are misparsed.
  - C#: a base-class overload is not considered once the derived type has a member with the same name.
  - C#: a member after `#endif` that follows a trailing comma is lost; this is a grammar limit.
  - Stage 06: on large checkouts, search scoring runs on the host thread.
  - Stage 06: Windows path case is not folded for `path` and `pathPrefix`.
  - Stage 07: startup restoration of worktree registrations can race project loading.
  - Stage 08: plugin and agent queries share the host's concurrency limit.
  - Stage 08: invalidations are sent to every `code-map.read` plugin, for all projects.
  - Still open: Windows runs, manual Claude Code/Codex CLI sessions, and performance gates.
- Validation (Linux, Node 24.22.0, Xvfb): `npm run check` green (1,380 unit / 1 skip, 75 integration / 60 skips,
  3 latency). E2E `code-map`, `code-map-visualizer`, `ensemble`, `file-preview`, `ipc-hosts`, `smoke`: 21/21 passed.

## Resume checkpoint

### Handoff after stage 10

- The plan explicitly scopes each implementation session to one stage; stage 10 is implemented. Continue at
  `etap-11-go-java-python.md` (Go first). Work on `main`, commit per stage, never push; the owner pushes local commits.
- Changes uses `oxy.git.getCheckoutChanges(ref)`, with `git.read` plus `code-map.read`. Worktree comparison derives
  task/base from authorized registration; it never accepts a plugin-supplied root/base. Strict selection applies to
  queries, history resets and source locators. Never substitute the main checkout after removal.
- `impact` slices use `paths` or `root` (mutually exclusive), incoming-only depth 1–3, no `contains` and no heuristic
  edges by default. Visit caps 2,000/5,000, slice caps 500/1,000/512 KiB; Git metadata separately caps 500 files/512 KiB.
  File dependency adjacency is lazy per generation and keeps original edge references; no second graph copy.
- Git and map snapshots are independent checkpoints. Deleted/excluded/renamed-away files remain in Changes metadata
  but cannot have current indexed dependents. Their absence is never evidence that the change is safe.
- Evaluation: `scripts/code-map-agent-evaluation.ts` has `validate`, `prepare` and `report`; it never invokes an agent.
  The frozen corpus is revision-specific, with 6 training and 20 held-out tasks. See the evaluation report for the
  paired protocol and required metrics. Actual sessions are deferred to the owner. No savings claims or Automatic
  learnings before measured gates. Future language stages must version/refreeze the corpus's unsupported answers.
- Stage 10 E2E: 22/22 passed in Docker/Xvfb, including Code Map, visualizer Changes/Impact/worktree source navigation,
  Ensemble, file preview, IPC hosts and startup. Full check passes on Windows (1,387 unit, 69 integration, 3 latency)
  and Linux with a child subreaper (1,391 unit, 77 integration, 3 latency). Windows build and headless shipped-iframe smoke pass.
  Full details and remaining release gates are recorded in `results/2026-10-20-insights.md`.

### Handoff after stage 09 (user requested stopping)

- Work directly on `main`, commit each remaining stage separately, never push: the user will push all local commits.
  Stages 06–09 are implemented. Stage 10 is next; stages 11a Go, 11b Java, 11c Python then 12–14 remain.
- Stage 09 files: `plugins/code-map-visualizer/src/host/index.ts` proxies public API calls; `src/shared/model.ts`
  validates view requests; `src/views/map.tsx` renders controls/details/list and imperatively updates Cytoscape.
  `src/views/state.ts` guards request identity and preserves surviving positions. Main has no graph rendering logic.
- Core `oxytocin.codeMap.openSettings` is allowlisted in main and renderer. Project menu and settings show the
  visualizer entry only when its command contribution exists. Disabling the plugin does not disable core MCP/indexing.
- Metadata audits can publish progress without changing a generation. The backend deliberately ignores in-progress
  invalidations and deduplicates identical generation/state checkpoints to avoid query → audit → refresh loops.
- Run `npx.cmd tsx scripts/code-map-renderer-benchmark.ts` for renderer timings and
  `npx.cmd tsx scripts/code-map-visualizer-smoke.ts` for the shipped iframe's offline/CSP/SDK behavior after building
  plugins. These launch headless Chromium, not desktop Electron. Reports/raw results are under `results/`.
- Stage 10 must add host-owned impact/dependents queries, Changes overlay and checkout selection. The existing public
  Git API currently accepts a project ID; worktree changes/base comparison need an authorized extension rather than
  reading arbitrary filesystem roots in the plugin. Export is optional; record the decision.
- For stages 10/14 the user explicitly chose harness/corpus preparation only. No paid agent sessions are authorized;
  the user will measure them later. Do not claim token/cost benefits or enable Automatic learnings before the gate.
- Follow the existing host ownership, bounds, strict checkout selection, project opt-in, plugin permissions and
  stale-generation contracts. Keep knowledge permission separate in stage 14; no learnings in structural slices.
- Full check/build and headless iframe logs: `test-results/code-map-stage09-*`. Added app E2E remains unexecuted.
  Repeat it in Linux/Xvfb when that environment becomes available; it does not become passed through this exception.
- Final stage 09 validation: `npm run check` passed (1,371 unit tests, 68 integration tests, 3 latency tests;
  4 unit and 66 platform/resource integration skips). `npm run build` passed. Final shipped-asset iframe smoke passed.
- Important Windows test setup: set `TEMP` and `TMP` to
  `C:\Users\Public\oxy-code-map-validation-20261020-6c2d` and `VITEST_MAX_WORKERS=4` per command. The default 8.3 temp
  path crashes existing native watchers; temporary non-Git fixtures must live outside this repository.
- Existing release gates are still open: large-checkout performance, installer/Windows CI/determinism, actual CLI
  clients, Electron E2E, terminal p95 during visualization, production accessibility review and dogfooding.


### Stage 08 implementation

- Public API 0.2.0, `code-map.read`, validated/cancellable plugin queries and targeted metadata invalidations.
  Overview/file/neighborhood slices have node, edge and UTF-8 envelope caps; late generations discard old data.
- Verified source navigation preserves worktree identity through editor routing. Documentation and fixture plugin
  integration cover permissions, opt-in, agent/plugin consistency, source edits and editor column conversion.
- Full check and build passed. Validation logs and E2E exception: `results/2026-10-20-plugin-api.md`. Added Electron E2E was
  not executed under the user's authorization; it remains a release gate.
- Next: stage 09 renderer spike and built-in visualizer, then 10–14 in order. Paid evaluation remains deferred.

### Stage 06 validation

- `npm run check` green: 1,354 unit tests passed / 3 skipped, 66 integration passed / 66 skipped by platform/resource
  availability, 3 latency passed. `npm run build` green. Logs are under `test-results/code-map-stage06-*`.
- Small-fixture warm HTTP search p95 71.28 ms (50 samples), deterministic ranking fixture recall@8 1.0.
- App E2E and interactive Claude Code/Codex CLI checks remain unexecuted; see the stage results report.

### Stage 07 validation

- Full check green: 1,360 unit tests / 4 skips, 67 integration tests / 66 platform/resource skips, 3 latency tests.
  Build green. Logs: `test-results/code-map-stage07-check.log` and `code-map-stage07-build.log`.
- Live worktree and role HTTP tests passed. Added app E2E remains unexecuted under the user's documented exception.

- Continue through stages 08–14 in order, with a separate commit after each stage. The user will push all commits;
  do not push from this session (explicit 2026-10-20 instruction).
- For stages 10/14, the user chose an evaluation harness and corpus only; they will run paid model measurements later.
  Do not spend paid tokens or claim measured benefits. The Automatic learnings release gate remains unverified until
  those results exist, so it must not be offered as a product mode before that gate passes.
- Current machine: Windows, Node 24.16.0; dependencies installed with npm ci. Docker is absent and WSL has no installed
  distribution. The user explicitly authorized committing after available checks while recording missing E2E.
- For Windows checks, set command-local `TEMP`/`TMP` to `C:\Users\Public\oxy-code-map-validation-20261020-6c2d` and
  `VITEST_MAX_WORKERS=4`. The default short temporary path triggers existing libuv watcher assertions and a PowerShell
  status-line test failure. Do not put temporary fixtures inside this repository: non-Git tests would inherit Git.
- Stage 06 adds host-owned search/outline/relations/repo-map, a pinned graph checkpoint, independent reader cancellation,
  two-second latest/verified waits, explicit stale reads, strict checkout selection and immediate opt-out checks. No
  source snippets are emitted. Graphs/indexes are reused by unchanged metadata audits. The Code Map tab reports real
  MCP availability and links to Agent Tools. Tests include live HTTP calls and a deterministic E2E client (unexecuted).
- Existing release gates remain open: performance on large checkouts, installer/Windows CI, determinism and dogfooding.
  Manual Claude Code/Codex CLI sessions and app E2E are still required before claiming stage 06 release readiness.
