# Code Map implementation status

Updated: 2026-10-19. Base revision: `bd1355d`. Working branch: `main`.

## Current work

- Stage 00 complete: reproducible parser and Windows ASAR packaging benchmark, grammar integrity manifest and deterministic 10,000-file fixture. Decision: Tree-sitter WASM, lazy grammars, explicit CommonJS runtime entry.
- Stage 01 complete: contracts, lazy host supervision and build assets, safe storage and Git ignores.
- Stage 02 complete: enumeration, live observation, fingerprints, global scheduling and activity hints.
- Stages 03–14 pending. No user-facing Code Map functionality is available yet.
- Read `README.md`, the current stage document and this file before continuing. Follow the dependency order; do not mark measurement gates complete without recorded results.

## Environment and validation

- Windows, Node 24.11.1; use `npm.cmd` / `npx.cmd` in PowerShell (the execution policy blocks `npm.ps1`).
- Docker Desktop Linux engine is available, including the existing `oxy-e2e:latest` image. Run Electron E2E in Docker under Xvfb; never open desktop windows.
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
