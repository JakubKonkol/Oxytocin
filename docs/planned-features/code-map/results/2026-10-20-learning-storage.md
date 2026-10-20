# Stage 12 — durable learning storage and manager

Implementation continues the earlier foundation checkpoint. No provider calls, terminal transcript collection or
automatic repository instruction edits are involved. Automatic admission remains unavailable pending the owner's
deferred evaluation.

## Storage and lifecycle

- Live checkout findings remain in that checkout's `.oxy/learnings/learnings.json`. Before Ensemble removes a
  directory, the host archives its records and revisions under the project's
  `.oxy/learnings/archives/<checkout-hash>/learnings.json`. The original checkout identity remains on every claim.
  An archival failure blocks deletion/finish; a retry retains the captured authority. Git merge never promotes notes.
- Explicit user promotion rechecks evidence in the selected live checkout (the main checkout for archives), moves
  the finding and its history into project storage and records user reviewer provenance. Applicability is checked
  separately for each consuming checkout. Archived checkout claims are inspectable but do not become another
  checkout's local knowledge.
- A project lease plus leases for authorized live stores serialize instances. Machine-local usage reservations
  account for stores written by other instances, without loading filesystem roots from persisted metadata. Logical
  limits include 2,000 records and 32 MiB including revisions; writes return prune guidance and never silently evict.
- Retry digests and usage accounting live in `local/`; portable JSON contains claims, their lifecycle and history.
  The previous foundation envelope with embedded retries remains readable and is rewritten on the next mutation.
- A local transaction journal coordinates promotion, archive publication and forgetting across stores. It records
  checkout identities rather than filesystem roots; recovery resolves those identities against current main
  authorization. Missing authorization fails closed and asks to restore the checkout before repair.
- Delete/forget rewrite history and recovery replicas and remove transaction/atomic-write temporary copies. Export
  contains only the selected checkout's visible records/history, with no retry metadata, machine roots or credentials.
  Findings already exported outside the application cannot be erased by it.

## Evidence and review

- A separate evidence watcher maintains a reverse path index, so a raw event latches NeedsReview independently of
  parsing, pause or rebuild. A change followed by reversion between manager/context reads still needs review.
- Reads also hash bounded evidence files. Admission and acceptance read evidence twice and verify both the graph
  generation and watcher epoch before publication. Explicit document spans are bounded against the actual text.
  Symbol references require the exact non-stale indexed identity.
- Review checks current topic alternatives, including alternatives proposed after the reviewed draft. Pending
  replacements preserve the accepted claim until user review. Self replacement and replacement cycles are rejected.
  Cross-store replacement chains are refused with a request to edit in the original checkout manager.
- Original author, last editor and reviewer are separate fields. Matching evidence establishes applicability, not
  semantic truth. Reviewed unanchored claims still expire after 30 days.

## Manager and repair

The core Learnings manager has a main/live/archive selector and works without the visualizer. Archived records can
be inspected, rejected, exported, forgotten or explicitly reviewed against main and promoted. Save/accept against a
removed source are disabled. Shared project findings remain visible when checking another checkout.

Unknown schemas and unrecoverable corruption appear as an error in the manager and are never replaced as cache.
Preserve `.oxy/learnings/` before repairing such a store or updating to a compatible application. A full-store error
asks the user to export and delete a finding (including its revisions), or forget the selected visible findings.
Removing a project from the application explicitly states that durable findings remain on disk.

## Validation

- Full Windows `npm.cmd run check` passed: typecheck, repository lint/format, 1,412 unit tests (6 skipped),
  69 integration tests (66 skipped by platform/resource availability), 3 latency tests and license allowlist.
- The final conflict-policy addition was checked with typecheck, focused lint and the full memory suite: 19 passed
  / 1 symlink test skipped on Windows, **20/20 passed on Linux**. Coverage includes alternatives sharing a replacement
  target even without a topic, and continued reads after a quota refusal.
- Docker/Xvfb `npm run e2e -- tests/e2e/code-map.spec.ts`: **12/12 passed**, including the new real Ensemble lifecycle.
  It deliberately corrupts the worktree's schema, confirms directory removal fails, restores the intact store,
  retries removal, inspects the archived identity and promotes the finding through the core manager.
- Docker built the application, SDK and bundled plugins. The existing map, language, MCP, verified navigation,
  rebuild/deletion and instruction-file flows remain green. No desktop Electron window was launched.
- Logs: ignored `test-results/code-map-stage12-check.log` and container `/tmp/code-map-stage12-{memory,e2e}.log`.
  No longitudinal/model evaluation was performed, and no measured token or cost benefit is claimed.
