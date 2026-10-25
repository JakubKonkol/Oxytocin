# Stability review — 2026-10-25

This review prioritizes data loss, asynchronous lifetime bugs, retained resources and unnecessary background work
before the next release. It covers the current main branch without changing the existing Code Map beta labels.

## Confirmed problems and repairs

| Area | Failure scenario | Repair and regression coverage |
| --- | --- | --- |
| Editor and diff saves | A user types while the previous version is being written; completion marks the new text clean and save-and-close can discard it. | Capture the model and its version before writing, mark only that version saved, return false to close callers while newer edits remain, and coalesce concurrent saves. Tests delay IPC completion and edit again before resolving it. |
| Automatic editor reload | A file read starts while the editor is clean, then overwrites typing that began during the read. | Recheck dirty state after reading and reject superseded reads. A delayed read test verifies that the text and unsaved indicator survive. |
| Diff conflicts | A live refresh updates the stored disk modification time or bypasses the conflict check while local edits remain. Subsequent saves can also reuse the time from before a successful write. | Keep the edit's original disk timestamp separately, always check it for normal saves, and advance it on successful saves or explicit reloads. Tests verify conflict cancellation and a second save. |
| Editor lifetime | A failed refresh replaces the editor with an error view; a deleted/binary/oversized diff can dispose the model containing unsaved work. | Keep the editor mounted, report reload failures inline and defer incompatible disk content until explicit reload. Preview files also have independent component lifetimes. Tests cover failed refresh, deletion and switching files during a save. |
| Utility hosts | Stop during restart backoff leaves ready callers waiting; another start can leave two children; interrupted pings affect another process; disposal relies on an exit event. | Reject waiters immediately, guard starts and late replies, stop health checks during shutdown, and release RPC, listeners and timers directly. Fake-process tests include a kill that never emits exit. |
| RPC | A request completes after disconnection, then sending both the response and its error fails, rejecting a detached task. Empty event sets can accumulate. | Drop replies after disposal, contain response-send failures, remove empty listener sets and refuse new listeners on disposed channels. Tests exercise successful, failing and unknown requests with a closed transport. |
| Database pools | A dropped connection rejects after a replacement was created under the same key; its rejection deletes the replacement and loses ownership of it. | Delete only the matching entry, reject new requests after disposal and close drivers that finish opening during shutdown. Deferred connection tests verify replacement ownership and cleanup. |
| Git watchers | A slower configuration replacement overwrites a newer request or restarts watching after project removal; late discovery publishes stale state. | Track request identity and disposal, invalidate pending replacements on removal, and check entry identity after asynchronous discovery. Tests deliberately delay unsubscription and discovery. |
| Git refresh queue | Events received while a repository waits behind another job are included in its scan but also trigger an unnecessary follow-up. | Clear the dirty flag when consuming queued events, while preserving follow-up scans for events received during execution. The regression test verifies one scan for the accumulated batch. |
| JSON persistence | Serialization throws outside the write error handler, permanently rejecting the serialized promise chain. | Treat serialization as part of the protected write; a later valid update can be saved. A cyclic-value regression verifies recovery. |
| Windows test subprocesses | Git and plugin-generator helpers do not explicitly hide console windows. | Set `windowsHide: true` in the affected integration helpers. No Electron window or E2E runner is launched. |

## Architectural assessment

The separation between the main orchestrator, renderer and utility hosts is appropriate for this application:
terminal traffic bypasses React state, git refreshes are queued, and Code Map work runs outside the main process.
The actionable problems found here were predominantly missing ownership checks across `await` boundaries, rather
than a need to replace that process architecture. The repairs preserve those boundaries and add deterministic
regressions at the points where ownership changes.

The review also inspected terminal channel/session cleanup, plugin activation and shutdown, HTTP/MCP handling,
database service deadlines, Code Map scheduling and JSON storage. Inspection alone is not a memory profile or proof
that every failure mode has been excluded. The performance repair above removes a redundant scan; no general CPU,
RSS or startup improvement is claimed without measurements.

## Validation scope

Validation uses TypeScript, ESLint/Prettier, the production build, Vitest unit-node/unit-web and headless integration
tests. The renderer tests use jsdom with a controlled Monaco model and delayed IPC, rather than a desktop window.
Tests use two workers because the initial unrestricted run timed out in Code Map file/SQLite tests; all four affected
suites passed when rerun with two workers.

E2E, screenshot, packaged-application tests and an interactive soak session are intentionally excluded at the user's
request. External database integration cases requiring configured servers and platform-specific cases remain skipped
when their prerequisites are absent. This review therefore does not certify packaged GUI behavior, long-running heap
usage, or every external database engine.

## Results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run lint` | ESLint and Prettier passed. |
| `vitest run --project unit-node --project unit-web --maxWorkers 2` | 241 files passed; 1,646 tests passed, 6 skipped. |
| Final editor regression run | All 7 passed, including the additional preview-switch test added after the full unit run. |
| `vitest run --project integration --maxWorkers 2` | 18 files passed, 2 skipped; 71 tests passed, 66 skipped. |
| `vitest run --project integration-latency` | All 4 passed, run separately. |
| `npm run build` | Application, SDK and built-in plugins built successfully. |
| `npm run licenses:check` | Passed; no dependency changes. |

The build reports large generated chunks and Rollup annotation warnings from Zod. They do not fail the build;
their presence alone does not establish a runtime bottleneck. No packaged release was published during this review.
