# Code Map implementation status

Updated: 2026-10-19. Base revision: `bd1355d`. Working branch: `main`.

## Current work

- Stage 00 complete: reproducible parser and Windows ASAR packaging benchmark, grammar integrity manifest and deterministic 10,000-file fixture. Decision: Tree-sitter WASM, lazy grammars, explicit CommonJS runtime entry.
- Stages 01–14 pending. No production Code Map functionality is available yet.
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
