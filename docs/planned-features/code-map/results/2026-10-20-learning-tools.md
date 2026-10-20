# Stage 13 — task context, proposals and feedback

## Contract

The original five structural tools retain their inputs and outputs. Three new tools use strict schemas in MCP,
main and the host: `oxy_task_context`, `oxy_propose_learning`, `oxy_learning_feedback`. Context remains available with
memory Off and returns code only; writes are hidden when no enabled project permits them and every call checks the
current project policy. Automatic admission is not offered.

Proposals use `draft` (kind/title/body/rationale, optional topic/replacement and up to eight evidence references),
`expectedRevision: 0` for the new record and a stable idempotency key. A replacement is another proposal; agents
cannot edit accepted content, approve, delete or promote. Host hashes, graph generations and watcher epochs pin
evidence; caller-supplied authors, sessions, hashes and claims of verified tests are refused.

The Hub records source `agent`, role `hub` and a machine-local producer digest of the authenticated session. A
terminal header does not establish authorship. Ensemble provenance comes from its live role token and contains the
actual role/task; the bridge forces its authorized checkout. Tokens are hashed before becoming receipt principals.
Revocation cancels in-flight host work and invalidates that principal's receipts. Main also revokes requests and
receipts on checkout removal, memory disable, map disable/deletion and project policy changes.

## Retrieval and budgets

Context uses lexical search and exact path/symbol anchors, file diversity and one supported relation hop (bounded by
the structural traversal limit). It filters wrong-scope, proposed, rejected, superseded, stale and conflicting
findings before ranking. At most three reviewed/current claims survive. Evidence is rechecked on each context read;
watcher invalidation remains sticky. Reviewing a shared claim in one checkout preserves other checkouts' review
requirements.

The character budget includes provenance, complete evidence, freshness, coverage, warnings, omission counts and the
receipt. Defaults are 8,000 characters, maximum 24,000. About 70% of remaining capacity goes to code/relations and
30% to findings; unused space can be borrowed. Whole items are omitted. Insufficient metadata space produces
`BUDGET_TOO_SMALL`, never a cut JSON document. Missing or corrupt memory degrades to explicit code-only context.

Proposals are limited to 50 per checkout/hour. Feedback is bounded to 200 writes/hour and local retry metadata has
its own cap. Keyed retries do not create proposals or confirm truth. Duplicate feedback on one emitted item/outcome
is counted once, even with another retry key. Feedback counters and retry references are local; portable JSON holds
claims and lifecycle state.

## Receipts and feedback

Receipts retain selected IDs/revisions/reasons and `(checkout, code generation, memory revision)` for 30 minutes.
The cache is bounded to 256 receipts / 4 MiB. It stores no original question, transcript, source text or bearer token.
Feedback requires an exact emitted claim/revision and the same authenticated session/principal/checkout; unknown,
expired, forged or cross-session receipts fail. `outdated`/`incorrect` creates a checkout-specific NeedsReview state,
without approving or promoting anything. Feedback does not establish semantic truth.

Instruction copy text and the explicit CLAUDE.md/AGENTS.md buttons now mention the three tools and “Propose only
reusable, evidence-backed findings.” Exact old generated blocks can be upgraded or removed on demand; edited blocks
still require manual review. No background repository edits or provider calls occur.

## Validation

- Full Windows `npm.cmd run check` passed: typecheck, repository lint/format, **1,423 unit tests** (6 skipped),
  **70 integration tests** (66 platform/resource skips), **3 latency tests** and license allowlist.
- Docker host/storage suite: **27/27 passed**. Focused Windows core/host/service suite: **50 passed / 1 symlink skip**.
- Real HTTP integration: **4/4 passed**, including the three learning tools, independent session reuse, forged
  provenance refusal, memory Off, budgets and evidence invalidation. Ensemble HTTP tests verify authenticated
  role/task origin, forced checkout selection, token hashing and cancellation on revocation.
- Docker/Xvfb application build, SDK/plugins and Code Map E2E: **13/13 passed**. The new fake MCP client proposes a
  finding, the user accepts it in the manager, a second session reuses it, cross-session feedback fails, and a source
  edit removes it from context. Existing worktree/language/map/instruction flows remain green.
- Two reviewed MAP.md snapshots changed only in the agent instruction paragraph; graph contents and their hashes
  are unchanged. Historical generated instruction blocks have explicit upgrade/removal coverage.
- Logs: ignored `test-results/code-map-stage13-check.log`, container `/tmp/code-map-stage13-{memory,e2e}.log`.
  No desktop windows, provider calls or paid longitudinal evaluation. No measured cost or token benefit is claimed.
