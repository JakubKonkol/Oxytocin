# Code Map checkpoint: continue stage 12

> Historical checkpoint. Stage 12 is now completed; see [the storage report](2026-10-20-learning-storage.md) and
> [current status](../status.md). The owner subsequently requested autonomous continuation and a push per stage.

The owner requested a checkpoint, handoff and push on 2026-10-20. This supersedes earlier no-push instructions in
historical progress notes. Work stays on `main`. Do not treat the request to finish the session as completion of
stages 12–14. No paid evaluations or provider calls were made.

## Completed before this checkpoint

- Stage 10: `44ccf7b`, impact/changes, authorized checkout comparisons and offline evaluation harness/corpus.
- Stage 11a: `d5876b6`, Go.
- Stage 11b: `0452e8b`, Java.
- Stage 11c: `072ca72`, Python.
- Each has its own results report and full checks/E2E. Packaged 10k measurements are recorded; memory targets remain
  unmet. The stage 10 evaluation corpus describes its pinned earlier revision: version it before evaluating new
  language support rather than silently changing its reference answers.

## Stage 12 foundation in this checkpoint

This is a usable **main-checkout user manager**, not the complete stage 12 contract.

- Shared strict schemas: `src/shared/domain/code-map-memory.ts`; product memory settings accept only `off`/`review`.
  Default is review when enabled. Automatic must remain unavailable until the recorded paid evaluation gate passes.
- Host `memory/store.ts`: versioned JSON, size bounds, atomic pending/recovery/primary publication, crash replay,
  unknown-schema refusal and delete/forget purging all recovery/history/temp copies. Files live in
  `.oxy/learnings/learnings.json` and `.oxy/learnings/local/`.
- Host `memory/admission.ts`: serialized mutations, owner lease, optimistic record revisions, idempotency digests,
  normalized deduplication, topic/replacement conflicts, explicit accept/reject/promote, immutable old revisions,
  logical 2000-record/32-MiB bounds. Replacement supersedes only after acceptance.
- Host `memory/applicability.ts`: host-computed whole-file hashes, excluded/secret/path checks, size/binary/race
  checks, exact optional symbol identity, latched NeedsReview and 30-day expiry of unanchored reviewed findings.
  It rechecks hashes when the manager reads; it does not yet maintain a watcher reverse index.
- Main authorizes project/root. Renderer cannot supply a root or author. Validated host RPC and renderer IPC.
  **Main intentionally rejects worktree memory and all agent origins** pending the remaining lifecycle/security work.
  Main sends only the main checkout to this foundation; internal multi-store scaffolding is not a product contract.
- Core settings UI works without the visualizer or enabled map: search/state filter/paging, draft/evidence fields,
  save revision, detail/history, accept/revalidate/reject/promote, replacement ID, JSON download, confirmed delete
  and forget. Evidence state is refreshed explicitly with Refresh learnings. Map rebuild/deletion preserves notes.
- `.oxy/README.md` now distinguishes derived map data from durable findings.

## Finish before marking stage 12 complete

1. Worktree lifecycle: keep findings in their original checkout; archive before Ensemble removes the directory;
   inspection of archived identities, user promotion into project storage, applicability checked independently per
   checkout. Add a checkout selector/appropriate manager inspection. Never automatically promote during merge.
2. Project-wide budgets must cover every live/archive store and revision under a coordinated writer protocol.
   Internal multi-store scaffolding currently reads stores supplied by main, while main supplies only one root.
   Revisit ownership/recovery for every store before enabling it. Move retry/counter metadata into `local/` if the
   versioned primary is to contain only portable claims; currently retries are part of the envelope and replicas.
3. Watcher reverse index: invalidate relevant findings immediately on evidence changes, including while the map
   rebuilds. Context reads must revalidate before ranking, with a sticky review requirement even after file reversion.
   Current on-read hashing is adequate for the manager but cannot observe an edit and revert between reads.
4. Review/admission race handling: proposal has a second evidence/generation check; acceptance currently reads
   once. Pin/verify the generation and hashes again before accepting. Source/span proof must stay aligned with the
   indexed generation; enforce span bounds for explicit document ranges too. Broaden adversarial race tests.
5. Conflicting proposed alternatives need a complete conflict/applicability policy before agent retrieval is added.
   Current reviewed-topic conflict rejection and explicit replacement are manager behavior only.
6. Expand crash/recovery/failure-injection tests, cross-instance writers, full-store prune guidance, symlink races,
   removed project disclosures, and export verification. Unknown schema is preserved; there is no migration from
   earlier versions because this is the first schema. Decide how to expose repair errors to users.
7. UI currently edits findings authored by the user in main only. The stored `origin` persists the first author;
   add explicit revision reviewer/editor provenance when implementing agent/user edits and readmitted revisions.
   Validate any previously accepted replacement relationships against cycles/self references.

## Then stage 13

Read the full stage document and README 8.10 before coding. Add three MCP tools (`oxy_task_context`,
`oxy_propose_learning`, `oxy_learning_feedback`) with authenticated role/session checkout context, strict schemas,
50 proposals/checkout/hour, complete-item output budgets and real HTTP/E2E tests. Keep the five existing structural
tools unchanged. Never accept caller identity, hashes or claimed tests as verified provenance. Agent writes remain
disabled until this is implemented. Task context filters stale/conflicting/pending/wrong-scope findings before
ranking; at most three accepted findings. Receipts live 30 minutes, have no prompt/transcript, bind to session/role,
checkout, code generation and memory revision. Feedback can suspend applicability, never approve or promote.

## Then stage 14

Add permission `code-map.knowledge.read`, API patch version and public plugin surfaces, Knowledge and receipt views,
documented core commands, and permission-leak/expiry/revocation tests. Mixed slices require both permissions.
Prepare the longitudinal corpus/harness (10+ sequences, 3+ sessions, four arms, 3 repeats, isolated stores). Actual
paid runs remain deferred to the owner. Do not offer Automatic or claim measured savings without those results.

## Validation/environment

- Windows: use `npm.cmd`/`npx.cmd`; set `TEMP` and `TMP` to a long path outside this repository, e.g.
  `C:\Users\Public\oxy-code-map-validation-20261020-6c2d`, and `VITEST_MAX_WORKERS=4` for full checks.
- Docker `oxy-code-map-work` contains Linux dependencies in `/work`, read-only workspace bind `/source`. Start it if
  stopped. Sync source using tar excluding root deps/build/Git/test-results, then explicitly copy tracked fake CLIs
  from `/source/tests/fixtures/agents/node_modules/` into `/work/tests/fixtures/agents/node_modules/`.
- E2E: `xvfb-run -a npm run e2e -- tests/e2e/code-map.spec.ts`. Never open desktop Electron windows.
- PID 1 in that container does not reap grandchildren; Linux full checks need the subreaper helper documented in
  status.md (`/tmp/code-map-stage10-reaper.py`). Windows full checks do not need it.
- Raw logs are ignored under
  `test-results/` and `/tmp/code-map-stage12-*` in the container.

### Checkpoint validation results

- Windows full `npm.cmd run check`: passed (typecheck, repository lint/format, unit suites, integration, latency,
  license allowlist). Unit run: 1,403 passed/5 skipped; integration: 69 passed/66 skipped; latency: 3 passed.
- Final focused storage/evidence tests after the small fixes: **10/10 passed**. Includes CRLF/BOM normalized graph
  hashes versus raw evidence hashes, independent document evidence, no directory creation for an empty manager,
  idempotency/revision conflicts, evidence invalidation/reversion, expiry, secret/size/binary/path rejection,
  replacement review, forgotten-content recovery, incompatible schemas and checkout store isolation.
- Docker/Xvfb app/SDK/plugin build and `tests/e2e/code-map.spec.ts`: **11/11 passed**. New UI flow tests memory mode,
  creation/review, evidence change/revalidation, rebuild, map deletion preserving findings, and confirmed forget.
  Existing language, MCP, source navigation and instruction-file flows remain green.
- The initial UI run exposed an accidental form submission from the list button; it now explicitly uses
  `type="button"`. Evidence validation now distinguishes indexed sources from independent unsupported documents.
- Final typecheck and focused lint/format cover the final edits. This checkpoint did not rerun the entire Linux
  check; earlier language stages did. No longitudinal or paid model evaluation was performed.
