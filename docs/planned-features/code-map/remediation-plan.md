# Code Map — retrieval cost and accuracy remediation plan

Date: 2026-10-23. Oxytocin base revision: `0616b8c` (0.9.13). Status: **proposal**, not implemented.

Inspected upstream revisions (read-only clones, nothing executed):

- [Trail-Code](https://github.com/trailhq/Trail-Code) `257672ae8bb404e55af16a6d0076741ee2d7a6f8` (package `@nanonets/graft` 0.25.0, MIT).
- [graphify](https://github.com/Graphify-Labs/graphify) `92741d162b2094ffc2fed58cfbd8ee823e9da62c` (branch `v8`, Apache-2.0 with an MIT-licensed portion).

This document follows [`results/2026-10-21-retrieval-diagnosis.md`](results/2026-10-21-retrieval-diagnosis.md), which
already reduced response sizes. The owner's later test still found that a Claude Code session **with** Code Map cost
roughly 3–4× more than one using only the built-in tools, and that Code Map pointed at the wrong files. This plan
explains why, separates measured facts from hypotheses, and proposes a staged fix.

## 1. Summary

Code Map today is a **pull-only, pointer-only** retrieval layer: the agent must discover the tools, call one, receive a
list of locations (never code), and then read the files anyway. Every one of those steps is an extra model round trip
on top of what Grep + Read would have done, and the ranking is right on the first result only half of the time, so the
agent frequently pays for the map **and** for the normal search. Nothing in the current flow can make a task cheaper
than the built-in tools; it can only add calls.

Both reference projects get their savings from the opposite design:

- **Trail-Code** pushes 3 gated pointers into the prompt through a `UserPromptSubmit` hook (zero tool calls), inlines
  the relevant source into `find_code` answers so the follow-up read is usually unnecessary, ranks with BM25 over
  symbol **bodies** plus graph centrality, refreshes the graph before each query in milliseconds, and tells the agent
  to make *one* call. Its own benchmark shows that its pull-only variant (MCP tools, nothing injected) bought
  correctness, **not** savings — the savings came from push.
- **graphify** does not claim cheaper code tasks at all: its code-intelligence result is +11 points of key-fact
  coverage at ~140K tokens per query. It also learned that re-injecting a hook nudge on every tool call costs "far more
  tokens than the graph queries it asks for" and now rate-limits it.

The fix is therefore not more tuning of the current flow. It is: (1) measure, (2) remove the overhead we add, (3)
rank on code content, (4) make answers substitutive (inline excerpts), (5) push a few pointers at prompt time through
the existing Claude Code Bridge, (6) keep answers available while the agent edits, and (7) gate the feature on a paid
A/B result.

## 2. What was measured

All measurements were taken in a Linux container on a fresh index of this repository at `0616b8c` (1,160 files,
950 indexed, 14,079 symbols, 62,798 edges), built headlessly with the real `CodeMapCheckouts` controller, parser
worker and grammars. Character counts are UTF-16 characters of the complete tool response, not billed tokens. No
paid agent sessions were run; the owner's original transcripts were not available, so the 3–4× figure itself is not
reproduced here — section 3 explains which mechanisms produce it.

### 2.1 Retrieval accuracy (22 realistic questions)

Each question has a ground-truth file established with `rg` before ranking (appendix A). "Rank" is the position of
the first correct file in `oxy_find_code` (limit 8); 0 means not returned. `oxy_task_context` produced **identical**
ranks for all 22 questions.

| Ranking                                 | hit@1      | hit@3      | hit@8      |
| --------------------------------------- | ---------- | ---------- | ---------- |
| Current `CodeSearch` (name/path/signature terms) | 11/22 (50%) | 17/22 (77%) | 19/22 (86%) |
| Prototype: BM25F over names, paths and symbol bodies, query-coverage², file grouping, test penalty | 14/22 (64%) | 20/22 (91%) | 22/22 (100%) |

The prototype (≈80 lines, not committed) only changed what is indexed and how it is scored. It also regressed three
questions from rank 1 to rank 2–3, so the corpus must be larger and frozen before any ranking change is accepted
(phase 0). The set is small and was written by the same session that wrote the prototype; treat the numbers as
direction, not proof.

The three current misses show the root cause. In each, the decisive term occurs only **inside** a function body:

- "Shift+Enter … newline" → `src/renderer/src/features/terminals/key-handler.ts` (`shiftKey`, `\x1b\r` in the body).
- "dropped files … paths in the preload" → `src/preload/index.ts` (`webUtils.getPathForFile` in the body).
- "plugin manifests discovered and validated" → `src/main/services/plugins/discovery.ts`.

`CodeSearch` indexes only `name + path + signature` (`src/code-map-host/query/search.ts:52-60`), weights a name match
3× a path match and multiplies by the share of query words matched. A symbol whose *name* contains two common query
words (`formatDroppedPaths`) therefore beats the file that actually does the work.

### 2.2 Response size and shape

| Response                                   | Size                         |
| ------------------------------------------ | ---------------------------- |
| `oxy_find_code`, 22 questions              | 1,224–2,474 chars            |
| `oxy_task_context`, 22 questions           | 1,281–2,451 chars            |
| Fixed header in every answer               | ~250 chars (3 lines)         |
| `symbolId=` line per symbol match          | repeats the full path, ~70–90 chars |
| JSON schemas of the 8 Code Map tools       | 9,788 chars (~2.8K tokens)   |
| Code Map MCP server instructions           | 502 chars (also copied verbatim into `CLAUDE.md`) |

A typical answer (question 15, abbreviated) shows the problems in one place:

```text
OK
checkout="proj-1" generation=1 degraded stale=false verification=metadata pending=0
coverage: 950 indexed, 208 file-only, 2 failed, 41 skipped; unresolved: 7 imports, 38642 calls. Partial index.
"src/renderer/src/features/terminals/path-quoting.ts":38-40 function "function formatDroppedPaths(…): string"
  symbolId="s:src/renderer/src/features/terminals/path-quoting.ts#function:formatDroppedPaths"
… 7 more pointers, none of them src/preload/index.ts …
Truncated: RESULT_LIMIT. Narrow the query or increase maxChars.
```

- Every answer says `degraded`, `Partial index` and `38642` unresolved calls (two TSX files fail to parse), which
  invites the agent to verify the answer with Grep.
- `Truncated: RESULT_LIMIT. Narrow the query…` is printed whenever more than `limit` candidates exist — i.e. almost
  always — and `oxy_task_context` adds `warning: Search result limit reached; narrow the question or increase limit`
  plus an `Omitted: {…}` line full of zeros. These lines read as instructions to query again.
- No source is returned, so every answer needs at least one `Read` before it is useful.

### 2.3 Freshness during the edit loop

After a one-line edit to `env-composer.ts`, a new generation was published after **1.6–2.7 s** (5 runs, includes the
300 ms debounce). The default `latest` query waits at most **2 s** (`src/code-map-host/query/freshness.ts`) and then
returns `INDEX_UPDATING` **without any data** and the hint "Retry after indexing, or use normal text search"
(`src/code-map-host/checkouts.ts:266-277`). An agent that edits and then queries — the normal implement loop — either
waits ~2 s or gets an empty answer and falls back to Grep. Earlier benchmarks recorded edit p95 of 4.4 s (TS 10k) and
12.4 s (C# 10k), where this is worse.

### 2.4 Graph completeness

Of 71,254 call relations, 32,612 are resolved and 38,642 are unresolved; 36,498 unresolved relation records have the
reason `unknown-value-type` (`src/code-map-host/resolve/bindings.ts:77`): calls on values whose type is not tracked,
such as `this.deps.service.query()` or a parameter annotated with an interface. Free functions resolve well (graph
callers matched `rg -w` for `comparePaths`, `boundResult`, `formatCodeMap`, `withinPrefix`); methods do not
(`getSettings`: 5 caller files in the graph, 8 with `rg`). `oxy_code_relations` is therefore least reliable exactly
for the refactoring questions where a map should beat grep.

## 3. Why a session with Code Map costs more

In an agent loop every tool call is a model turn: the model emits a call (output tokens, thinking), the result is
appended, and the whole context is processed again (cheap when cached, but the new tail is uncached input). For short
"find and change" tasks the **number of turns** dominates cost. The table compares the turn count of the documented
flows; it is a model of the mechanism, not a measurement of the owner's session.

| Step                                                         | Built-in tools | Code Map as instructed today |
| ------------------------------------------------------------ | -------------- | ---------------------------- |
| Load deferred MCP schemas (`ToolSearch`), see C1             | —              | 1 turn, +~3K tokens           |
| Optional `oxy_code_map_status` ("check freshness"), C3        | —              | 0–1 turn                      |
| Locate                                                       | Grep (paths only by default) | `oxy_find_code` and/or `oxy_task_context` (identical content), 1–2 turns |
| Read the code                                                | Read           | Read (no source in answers), C4 |
| Recover from a wrong first hit (50% of questions), C5         | —              | Grep + Read, 0–2 turns        |
| After an edit, query again (C6)                              | Grep           | wait ≤2 s or `INDEX_UPDATING`, then Grep |
| Total for one lookup                                         | **2 turns**    | **3–7 turns**                 |

Findings that explain the gap, most expensive first:

- **C1 — Discovery cost.** Oxytocin's Hub exposes ~30 tools. Claude Code defers MCP schemas when they exceed its
  budget, so an agent sees only names and must call `ToolSearch` before the first Code Map call (Trail measured the
  same: "111 tools deferred … graft's six arrived as six bare strings"). Our instructions never tell the agent to load
  all Code Map tools in one lookup, so it may pay for several lookups. The 8 schemas cost ~2.8K tokens when loaded.
- **C2 — The instructions make the map the default for everything.** `CODE_MAP_MCP_INSTRUCTIONS`
  (`src/shared/domain/code-map.ts:303`) is delivered twice (MCP `instructions` and the `CLAUDE.md` block) and directs
  the agent to `oxy_find_code` **or** `oxy_task_context` before reading, even when it already knows the identifier and a
  single Grep would do. It also mentions learnings, receipts and revisions in every session.
- **C3 — Two tools return the same thing.** Without learnings, `oxy_task_context` is `oxy_find_code` plus metadata
  (22/22 identical ranks). Agents that follow "find_code OR task_context" sometimes call both. `oxy_code_map_status`
  invites a status check before work.
- **C4 — Answers are not substitutive.** The stage 06 decision to emit no source snippets means a correct answer still
  costs a Read. Trail's `find_code` inlines the span (≤8-line crux or ≤80 lines), "usually the full answer, no follow-up
  read needed".
- **C5 — Ranking misses.** 50% hit@1 means the agent opens a wrong file half of the time, then searches normally:
  the map's cost is added to the baseline's, not substituted for it.
- **C6 — Freshness blocks the edit loop.** See 2.3.
- **C7 — Output encourages re-querying and distrust.** Permanent `degraded`/`Partial index`, "Truncated … narrow the
  query" and zero-valued `Omitted` lines (2.2).
- **C8 — Learnings encourage extra writes.** The instructions ask agents to "Propose only reusable evidence-backed
  findings". Trail saves a learning only when the user asks, and says so explicitly ("It never saves one on its own").

## 4. How the reference projects do it

| Concern                    | Trail-Code                                                                                                     | graphify                                                                                        | Oxytocin today                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Delivery                   | **Push**: `UserPromptSubmit` hook injects ≤3 pointers per prompt; `PostToolUse` after edits shows the blast radius; `SessionStart` orientation (cached). Pull: 6 MCP tools and CLI via Bash. | Skill + CLI via Bash; `PreToolUse` hook on Grep/Read nudges toward `graphify query`: the first nudge per agent always fires, later ones only if the graph was not queried recently, at most 5 per agent. MCP optional. | Pull only: MCP tools + instruction block.        |
| Gate on injections         | Inject only when the top hit matched a symbol **name** (`coverageStrong`) or most of the query (`coverage`); drop pointers already injected this session; ≤2 "weak match" nudges per session. | Nudge rate limit per agent/session (`_nudge_allowed`), learned after nudges cost more than queries. | n/a                                              |
| What is indexed for search | Name, path, signature, **symbol body tokens**, file-level residual (imports/constants), optional LLM summaries. | Labels, source path, docstrings and `# NOTE:`/`# WHY:` rationale comments, attributes; trigram prefilter. | Name, path, signature only.                       |
| Ranking                    | BM25 over bodies + idf-weighted name (×3) and path (×2) fields; query-aware test penalty (0.35); plural folding; personalized PageRank blend (0.5) with a rescue floor for central nodes the query didn't name; file-first selection; per-scope fusion in monorepos. | idf-weighted exact > prefix > substring tiers, squared query-coverage, full-label bonus, degree as tie-break. | idf-weighted term sum with name ×12 / other ×4, linear coverage, test ×0.65, docs ×0.7. |
| Answer content             | Pointers **plus inlined source** (crux or span, capped); `file_api` gives signatures only; `find_all` is an exhaustive regex grouped by enclosing symbol and ranked by in-degree. | Text subgraph within a token budget; seeds survive truncation; explicit "raise budget to N" hint. | Pointers, signatures, symbol IDs; no source.      |
| Freshness                  | Every query stats the tree (~3–50 ms) and refreshes only what changed before answering; never returns "updating". | Rebuild on commit/checkout hooks or `watch`; stale-for-target softens the nudge. | Background index; query waits ≤2 s, else no data. |
| Agent guidance             | One ~1,000-char MCP `instructions` string that survives tool deferral and says "load all tools in ONE `ToolSearch`"; "pick the ONE tool that fits … most tasks need a single call … already know the file or symbol? go straight to it". | "Prefer scoped `graphify query` over reading the report or grepping"; separate guidance for CLI vs MCP. | Same text in MCP instructions and `CLAUDE.md`; map-first for every lookup. |
| Method calls               | Receiver-type bindings from constructor assignments and type annotations; optional LSP pass (`--lsp`). | Resolver prefers no edge over a wrong one; `INFERRED` vs `EXTRACTED` tags. | Declared types for C#/Java; TS/JS unresolved (`unknown-value-type`). |
| Evidence                   | 162-run paired harness (push: −32% cost, −46% tool calls, −3 pts correctness on one corpus; pull: most of the speed gain lost, +5 pts correctness), SWE-bench Verified 50 (+12 pts, −23% tokens), per-repo PR replays. | Open harness; code intelligence +11 pts coverage at ~140K tokens/query. | Harness and corpus prepared (stage 10/14), never run. |

What we deliberately do **not** copy: LLM summaries and cruxes (out of scope: no model use by Oxytocin), telemetry and
"tokens saved" banners in every answer, mandatory "you MUST query the graph first" hook text (graphify's own history
shows it backfires), and global edits to user settings outside an explicit install action.

## 5. Target design principles

1. **Never add a turn the baseline would not take.** Code Map pays for itself only by replacing Grep/Read turns.
2. **Push a little, pull on demand.** At most 3 pointers per prompt, only when the match is strong and new.
3. **Answers are substitutive.** A correct hit contains enough code to act on without a second read.
4. **Answer from current code.** Prefer a fast targeted refresh over waiting; when stale, answer anyway and say which
   files are stale, never "retry later" with no data.
5. **Quiet by default.** No status header unless something is wrong for *this* answer; no truncation prose when the
   agent asked for the top N.
6. **Measured, not assumed.** No ranking, format or guidance change ships without the frozen corpus; the feature's
   default guidance ships only after a paid paired run passes its gate.

## 6. Plan

Each phase leaves a complete, usable state (CLAUDE.md rule 4) and is one or more commits. File references are to
`0616b8c`.

### Phase 0 — Measure first (no behavior change)

Goal: turn "3–4× more expensive" into a reproducible number and give every later phase a gate.

1. **Retrieval corpus.** Extend `scripts/code-map-retrieval-benchmark.ts` with a frozen, versioned question set
   (start with appendix A, grow to ≥60 questions across TS, C#, Go, Java, Python fixtures and this repository) with
   ground-truth files decided before ranking. Report hit@1/3/8, MRR, response chars and per-question diffs between two
   commits. Keep 1/3 of the questions held out.
2. **Session accounting.** Count Code Map tool calls, response chars and `INDEX_UPDATING` answers per MCP session in
   the Hub (`src/main/services/mcp/mcp-hub.ts`, counts only — no queries or code in logs, FR-AG-8). Usage Monitor
   already attributes tokens per Claude Code session; add a per-session "Code Map calls" column so a user's own A/B is
   visible without a harness.
3. **Small paid A/B (owner decision D1).** Run the existing paired harness (`scripts/code-map-agent-evaluation.ts`) on
   a reduced held-out subset first, e.g. 10 tasks × 2 arms × 3 repeats with `claude -p --output-format json`, to
   confirm the regression and record turns, uncached input, output and cost. The full 156-session protocol stays
   available for the release gate.

Acceptance: the benchmark prints current numbers for appendix A; the A/B (if approved) produces a report under
`results/`.

### Phase 1 — Remove the overhead (quick wins)

Expected effect: −1 to −3 turns per lookup without touching ranking.

1. **One locating tool.** Fold `oxy_task_context` into `oxy_find_code`: learnings are appended only when memory is on
   and something applies (receipt included then). Keep `oxy_task_context` as a deprecated alias for one release so old
   instruction blocks keep working. Hide `oxy_code_map_status` from the default list (status stays in the UI and in
   `oxy_capabilities`); keep `oxy_repo_map`, `oxy_file_outline`, `oxy_code_relations`.
   Files: `src/main/services/mcp/code-map-tools.ts`, `code-map-learning-tools.ts`, `mcp-hub.ts`.
2. **Smaller schemas.** Drop rarely useful parameters from the agent-facing schemas (`freshness`, `format`,
   `maxChars`, `relations` enum list, `includeHeuristic`; keep them in the plugin/IPC schemas) and shorten
   descriptions. Target: all Code Map tools ≤3,000 chars of schema in total (from 9,788).
3. **Rewrite the guidance** (`CODE_MAP_MCP_INSTRUCTIONS`), ≤600 chars, decision rules instead of features, e.g.:
   *"If the oxy_* tools are deferred, load oxy_find_code, oxy_file_outline and oxy_code_relations in one ToolSearch.
   Don't know where the code lives? One oxy_find_code call with the task in plain words, then act on it. Know the
   identifier or need every occurrence? Use Grep. Before changing a widely used symbol: oxy_code_relations
   (incoming). Don't repeat or reword the same query."* Remove learnings text unless memory is on. Add the current
   block to the recognised previous versions in `src/shared/domain/code-map-instructions.ts` so opted-in files upgrade.
   The `CLAUDE.md` block becomes one line pointing to the tools (the Hub already sends the full text), avoiding the
   duplicate.
4. **Quiet output** (`src/main/services/mcp/code-map-format.ts`):
   - Remove the header when `state` is ready/degraded, not stale and no matched file is stale; otherwise print one
     line naming the stale or failed files that matter for this answer. Coverage totals move to status.
   - Replace `symbolId=` lines by a short handle only where it is needed for a follow-up (`relations`), e.g.
     `#3` resolved per session, or emit `path:line name` which `oxy_code_relations` accepts as a selector.
   - Truncate long signatures (e.g. 120 chars).
   - Print "Truncated" only when the *character* budget cut results the agent asked for, never for `RESULT_LIMIT`.
     Remove zero-valued `Omitted` and the generic warnings.
5. **No "updating" without data.** When the 2 s wait expires, answer from the last snapshot and mark the files whose
   pending changes are known (`allow-stale` semantics by default, `latest` only on request). Files:
   `src/code-map-host/checkouts.ts:266-277`, `src/shared/domain/code-map-query.ts`.
6. **Memory proposals only on request.** Guidance: "propose a learning only when the user asks to save one".

Tests: format golden tests for each tool (sizes asserted), instruction-block upgrade test, Hub tool-list test, a
stale-snapshot query test; extend `tests/e2e/code-map.spec.ts` for the merged tool and the stale answer.
Gate: corpus hit rates unchanged; mean find response ≤60% of today's.

### Phase 2 — Rank on code content

Expected effect: hit@1 from ~50% toward ≥70% (prototype: 64% on 22 questions).

1. **Index bodies.** During extraction, emit per-symbol token counts of the body (identifiers split by
   camelCase/snake_case, string literals and comments included, stop words removed, capped e.g. 400 lines/2,000 tokens
   per symbol) plus a file-level residual document (imports, top-level constants, header comments). Store compact
   postings in the extraction cache record (bump the record format version so old caches reparse), never in
   `graph.json`. Files: `src/code-map-host/extract/record.ts`, `extract/*.ts`, `graph/build.ts`,
   `query/search.ts`.
2. **BM25F scoring.** Name ×3, path ×1.5–2 (idf-weighted presence), body BM25 (k1 1.2, b 0.75); multiply by the
   squared idf-weighted query coverage; light stemming/plural folding (`files`→`file`, `debounced`→`debounce`);
   exact identifier or path in the question (e.g. `getSettings`, `` `CodeMapService` ``) still wins outright.
3. **Query-aware penalties.** Tests ×0.35 unless the question mentions tests/specs/fixtures; docs/JSON ×0.5 unless it
   mentions docs/README/config files; generated/vendor paths excluded.
4. **File-first selection.** Group symbol hits by file, score a file by its best symbol plus a small bonus for
   additional matching symbols, return distinct files first and the best 1–2 symbols in each.
5. **Optional graph prior (only if the corpus improves).** Personalized PageRank seeded by the top lexical hits over
   resolved `imports`/`calls` edges, blended with weight ≤0.5, to surface the central helper a task depends on but
   did not name (Trail's "rescue"). The existing plan forbids PageRank until it improves the labeled corpus; keep that
   rule.
6. **Confidence signal.** Return `coverage` (share of query weight matched by the top hit) and `strong` (matched in a
   symbol name). Phase 4 uses them; `find_code` adds one line "weak match — consider Grep for <terms>" when both are
   low, instead of a confident-looking list.

Tests: unit tests per scoring rule, body-index build/incremental equality, cache version invalidation, memory/disk
budget checks (body postings must not push the 10k fixtures past existing peak RSS by more than an agreed margin —
measure with `scripts/code-map-benchmark.ts`). Gate: held-out hit@1 +15 points, no question drops out of top 8.

### Phase 3 — Make answers substitutive

Expected effect: −1 Read per successful lookup.

1. **Inline excerpts in `oxy_find_code`.** For the top 3 hits, read the current file from disk, verify its SHA-256
   against the graph (else mark the hit stale and skip the excerpt), and inline a deterministic excerpt: the lines
   that contain matched query terms inside the symbol span, ±2 lines of context, ≤12 lines per hit, ≤60 lines per
   answer, with `path:start-end` and "full definition: N lines". `full: true` returns the whole span capped at 80
   lines. Source stays untrusted data (JSON-quoted or fenced, FR-AG-8 logging rules unchanged). This reverses the
   stage 06 "no snippets" decision (owner decision D2); the original concern — mixing fresh source with an older graph
   — is handled by the hash check.
2. **`oxy_file_outline` as the cheap read.** Signatures and line ranges only, one line each, so the agent can read a
   precise range instead of a whole file.
3. **Exhaustive search grouped by symbol (`oxy_find_all`).** Literal/regex search over indexed files, hits grouped by
   enclosing symbol and ordered by incoming edges, capped output. This answers "every occurrence" without switching
   to Grep and then back; if measurements show agents still prefer Grep, drop it rather than keep a redundant tool.

Tests: excerpt selection, hash-mismatch path, budget caps, CRLF/UTF-16 positions, worktree checkouts; E2E for an
excerpt answer. Gate: in the paid A/B subset, fewer Read calls after `oxy_find_code` with equal correctness.

### Phase 4 — Push pointers at prompt time (Claude Code Bridge)

Expected effect: the main cost reduction; most lookups need zero Code Map calls.

The bridge plugin already answers `UserPromptSubmit` with `additionalContext` (the resource brief, once per session:
`plugins/claude-code-bridge/src/host/index.ts:40-50`) and already has `PostToolUse`.

1. On `UserPromptSubmit` in an Oxytocin terminal whose project has Code Map on, run one `oxy.codeMap.query`
   (`kind: 'search'`, limit 3, the stale-tolerant mode from phase 1) with the prompt text, within a ~1 s budget.
   Inject ≤3 one-line pointers (`path:start-end symbol`) only if the confidence signal from phase 2 passes
   (top hit matched a symbol name, or most of the query) and the pointers were not injected earlier in the session.
   Otherwise inject nothing (at most one short "no strong match" hint per session). No source in the injection:
   per-prompt text is uncached input on every turn.
2. On `PostToolUse` for `Edit`/`Write`/`MultiEdit`, optionally inject the incoming dependents of the edited symbols
   (≤5 lines, only when there are any and only once per file per session) — Trail's "blast radius". Ship behind the
   same project setting, measured separately.
3. Privacy and consent: today `HookInput` deliberately ignores prompts (`events.ts`). Reading the prompt is local
   (loopback, token-authenticated), never logged or stored, and must be explained in the bridge README and the Code
   Map tab. Expose one per-project setting, "Suggest code locations with each prompt", default decided by D3.
4. Codex/other agents: keep the MCP + instruction path; revisit when their hook APIs support context injection.

Tests: gating (strong/weak/duplicate), timeout fallback, no prompt text in logs, settings on/off; extend the bridge
E2E with a fake Claude hook client. Gate: in the paid A/B, median uncached input or exploration calls ≥15% lower than
the baseline arm with no correctness regression (the existing stage 10 gate).

### Phase 5 — Freshness that keeps up with the agent

1. **Targeted refresh on query.** Before answering, stat the files the answer would cite (and files with pending
   watcher events); re-extract only those (single-file parse is milliseconds) and answer with their fresh symbols and
   spans, leaving full re-resolution to the background generation.
2. **Incremental resolution.** Replace whole-graph re-resolution per edit (recorded as the main cost in
   `results/2026-10-20-optimization.md`) with re-resolution of the changed files and their direct importers.

Gate: after an edit, the next query answers within 300 ms p95 on this repository and on the TS 10k fixture, with no
`INDEX_UPDATING` answers in the E2E edit loop.

### Phase 6 — Better TypeScript/JavaScript call resolution

1. Track declared types of parameters, `const x: T`, class fields and constructor parameter properties
   (`constructor(private readonly deps: Deps)`), `new T()` assignments and simple return-type annotations, and resolve
   `x.method()`/`this.x.method()` through indexed classes, interfaces and type aliases (object-literal types
   included). This mirrors what the C#/Java resolvers already do with declared types and Trail's receiver bindings.
2. Keep provenance honest (`binding` vs `heuristic`); prefer no edge over a wrong edge.
3. Optional later (needs an owner decision, the current scope excludes running language servers): a precise mode using
   the TypeScript compiler API in a worker for TS projects only.

Gate: share of `unknown-value-type` on this repository falls by ≥50%; reviewed fixtures stay at 0 false positives;
`getSettings`-style method callers match `rg -w` on a sample of 20 methods.

### Phase 7 — Decide

Run the full paired evaluation (stage 10 protocol) after phases 1–4. If the gate passes, keep the guidance and push
on by default for Claude Code. If it does not, ship Code Map with the visualizer, impact view and explicit tools but
**without** the instruction block and push, so it can no longer make normal agent work more expensive, and record the
result here.

## 7. Decisions needed from the owner

| ID | Decision | Recommendation |
| -- | -------- | -------------- |
| D1 | Approve a small paid A/B (≈60 headless sessions) before and after phases 1–4. | Yes — without it no change can be shown to fix the reported cost. |
| D2 | Allow source excerpts in `oxy_find_code` answers (reverses the stage 06 decision). | Yes, hash-checked and capped. |
| D3 | Allow the Claude Code Bridge to read prompt text locally and inject ≤3 pointers per prompt; default on or off. | Yes; default on for projects with Code Map once the phase 4 gate passes, off before. |
| D4 | Deprecate `oxy_task_context` and hide `oxy_code_map_status` from agents. | Yes. |
| D5 | Body postings increase cache size and memory; accept a bounded increase. | Yes, with a measured cap. |
| D6 | Precise TS mode via the compiler API (phase 6.3). | Later, only if phase 6.1 is insufficient. |

## 8. Risks

| Risk | Mitigation |
| ---- | ---------- |
| Push injections become noise and cost more than they save (graphify's experience). | Strength + novelty gates, ≤3 pointers, ≤1 weak hint per session, no source in pushes, measured separately. |
| Body indexing raises memory/disk on large repos. | Capped tokens per symbol, postings in compressed cache records, benchmark gate. |
| Excerpts disagree with the graph after edits. | SHA-256 check per file; stale hits carry no excerpt. |
| Overfitting ranking to a small corpus. | Frozen, versioned corpus with held-out questions across languages. |
| Fewer warnings hide real staleness. | Staleness is shown whenever it affects the cited files. |
| Prompt text handling raises privacy concerns. | Loopback only, never logged or stored, documented, per-project setting. |

## 9. Sources

- Trail-Code: `README.md` (benchmarks, hooks, tools), `src/mcp/instructions.ts` (deferral-safe instructions),
  `src/mcp/tools.ts` (tool surface, refresh before query), `src/ask/ask.ts` (BM25F, coverage, test penalty, PageRank
  blend, inlined source), `src/claude/prompt-hook.ts` and `src/claude/format.ts` (`relevantRetrieval` gates,
  orientation directive), `src/graph/bindings.ts` (receiver types).
- graphify: `README.md` and `BENCHMARKS.md` (code-intelligence result), `graphify/cli.py` (`_run_hook_guard`,
  `_nudge_allowed`, nudge texts), `graphify/serve.py` (`_score_query`, `_subgraph_to_text`).
- Oxytocin: files cited inline; earlier results in `results/`.

## Appendix A — Retrieval questions and results

Ranks are the position of the first ground-truth file in the top 8 (0 = missing) for the current ranking and the
phase 2 prototype. Questions were asked in natural language, as an agent passes them.

| #  | Question | Ground truth | Current | Prototype |
| -- | -------- | ------------ | ------: | --------: |
| 1  | Where does Shift+Enter in the terminal send a newline to Claude Code? | `src/renderer/src/features/terminals/key-handler.ts` | 0 | 1 |
| 2  | How do we strip CLAUDECODE env variables before spawning terminals? | `src/main/services/terminals/env-composer.ts` | 1 | 1 |
| 3  | How is terminal output flow control with ACKs implemented? | `src/pty-host/flow-control.ts` | 1 | 2 |
| 4  | Where is the headless terminal mirror serialized for reattach? | `src/pty-host/headless-mirror.ts` | 2 | 1 |
| 5  | Where are IPC sender checks and validation done for handlers? | `src/main/ipc/router.ts` | 1 | 1 |
| 6  | How are utility host processes restarted after a crash? | `src/main/hosts/utility-host.ts` | 1 | 1 |
| 7  | Where do we read the HEAD version of a file for diffs? | `src/workspace-host/git/file-diff.ts` | 1 | 1 |
| 8  | Where is the git status refresh debounced? | `src/workspace-host/git/refresh-scheduler.ts` | 6 | 1 |
| 9  | How does the Usage Monitor compute the cost of tokens? | `plugins/usage-monitor/src/host/pricing/cost.ts` | 1 | 1 |
| 10 | Where is the Codex MCP server registration written? | `src/main/services/mcp/codex-registration.ts` | 1 | 1 |
| 11 | Where are plugin manifests discovered and validated? | `src/main/services/plugins/discovery.ts` | 0 | 3 |
| 12 | Where are terminal shell profiles detected? | `src/main/services/terminals/profiles.ts`, `shell-detect/index.ts` | 4 | 2 |
| 13 | How does the app check for updates? | `src/main/services/updates/update-service.ts`, `electron-updater-backend.ts` | 3 | 1 |
| 14 | Where are desktop notifications shown when an agent needs attention? | `src/main/services/notifications/notification-service.ts` | 1 | 3 |
| 15 | How are dropped files converted to paths in the preload? | `src/preload/index.ts` | 0 | 6 |
| 16 | Where does Ensemble create checkpoint commits? | `src/main/services/ensemble/ensemble-service.ts`, `src/workspace-host/git/ensemble-git.ts` | 1 | 3 |
| 17 | Where is the project activity indicator computed? | `src/main/services/activity/activity.ts`, `activity-service.ts` | 3 | 4 |
| 18 | How does code map search rank results? | `src/code-map-host/query/search.ts` | 3 | 1 |
| 19 | Where is the MCP tools list changed notification sent? | `src/main/services/mcp/mcp-hub.ts`, `http-server.ts` | 1 | 1 |
| 20 | Where are keyboard shortcuts defined? | `src/renderer/src/features/keybindings/shortcuts-model.ts` | 3 | 3 |
| 21 | How is the terminal link provider for file paths implemented? | `src/renderer/src/features/terminals/link-provider.ts`, `file-link-open.ts` | 1 | 1 |
| 22 | Where is the Claude Code plan hook that waits for the user's decision? | `plugins/task/src/host/hook.ts` | 3 | 1 |

Prototype scoring, for reproduction in phase 0: tokens = identifier-split terms minus English stop words with light
stemming; per document (each symbol: signature + body up to 400 lines; each file: first 60 lines)
`score = Σ idf·(3·[name] + 1.5·[path]) + Σ idf·BM25(body)`, multiplied by the squared idf-weighted query coverage,
×0.35 for tests, ×0.5 for Markdown/JSON; a file scores its best symbol + 0.25 × second + 0.1 × third.
