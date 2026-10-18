# Code Map design

Everything below is proposed behavior, not an existing API. Read [research](research.md) for the inspected implementation baseline.

> **Round three (2026-10-18) overrides this document where they differ.** The map is stored in the project's `.oxy/code-map/` folder ([specification](oxy-directory.md)), `/.oxy/` is added to `.gitignore`, agents also get a bounded `MAP.md`, and delivery follows the phases of the [implementation plan](implementation-plan.md). Business requirements are in [requirements](requirements.md). Self-learning ([learning and context](learning-and-context.md)) is phase 6. Languages (TS/JS and C# first) are specified in [languages](languages.md); `.gitignore` handling is on by default and can be turned off.

This document specifies the structural foundation (phases 1–2). [The visualizer](visualizer.md) covers phases 3–4. One core service serves agents, the core management UI, and plugins.

## User experience

Add **Project settings → Code Map** with an **Enable Code Map** switch and this explanation:

> Build a local map of saved code so agents can find symbols and dependencies. Updates automatically while Oxytocin is running. Optionally retain useful findings from agents for future tasks.

Show state, supported languages, indexed/skipped/error counts, last successful update, map size, and whether agent access through MCP is available. Provide **Rebuild**, **Pause updates / Resume updates**, **Delete map data**, exclusions, and **Copy agent instructions**. Rebuild is asynchronous and cancellable. The status view must remain useful with MCP disabled; show the existing Agent Tools setup entry point when needed. If learnings ship (phase 6), add memory mode and Learnings management; when the visualizer plugin is enabled, add **Open Code Map**. Display separate indexing, memory, and visualizer availability rather than one ambiguous enabled indicator.

States: `disabled`, `indexing`, `ready`, `updating`, `paused`, `degraded`, `error`. `ready` means no known pending changes at the latest checkpoint, not complete semantic knowledge. Parser failures can produce `degraded` coverage with useful results; a missing/unreadable root with no usable graph produces `error`. Display diagnostics without repeated toasts on every edit.

Enabling begins enumeration and indexing; it does not require an agent session. Disabling cancels work, releases watches, denies subsequent map reads for that project, and retains the cache for fast re-enabling. Pause suspends updates but permits explicitly stale reads. Delete map data cancels in-flight work and removes only that checkout's `.oxy/code-map/`. Removing a project stops its map and checkout registrations but leaves `.oxy/` in the user's folder. Changing its root invalidates the old association before indexing the new root.

No global master switch in the first release: project opt-in is sufficient. Enabling creates `.oxy/` and appends `/.oxy/` to the project's `.gitignore` (round-three decision, see [oxy-directory](oxy-directory.md#keeping-oxy-out-of-git)). No automatic changes to `CLAUDE.md`, `AGENTS.md` or `.mcp.json`; the instruction block is inserted only on an explicit user action. New agent sessions receive a short MCP brief; existing sessions discover changes through the existing tool-list mechanism and tool descriptions. Do not assume clients reread initialization instructions dynamically.

Phases 1–2 offer status, `MAP.md` and agent tools. Phase 3 adds a concrete explorer plugin with package/file clusters, symbol neighborhoods, relation/evidence filters, source navigation, and a list alternative. Graph construction belongs to core even when the plugin is absent; never render the entire large graph by default.

## Process ownership

```mermaid
flowchart LR
  UI[Project settings] --> Main[CodeMapService in main]
  Agent[Agent MCP client] --> Hub[Existing MCP Hub]
  Hub --> Main
  View[Visualizer iframe] --> Plugin[Plugin backend]
  Plugin -->|Public bounded API| Main
  Main <-->|Validated Port RPC| Host[Code Map utility host]
  Files[Saved project files] --> Watch[Parcel watcher]
  Watch --> Host
  Host --> Parser[WASM parser and resolver]
  Parser --> Cache[.oxy/code-map files]
  Cache --> Query[Bounded search and traversal]
  Host --> Memory[Learnings, phase 6]
  Memory --> Query
  Query --> Host
```

Main owns settings, authorized checkout identities, subscriptions, supervision, and orchestration. The host owns enumeration, filesystem watching, parsing, content hashes, graph assembly, search indexes, and `.oxy` I/O; learnings (phase 6) would add durable memory and context assembly in the same host. Renderer receives compact status updates and bounded results through the existing validated IPC/preload route. The plugin uses the public backend API through main and does not read `.oxy` files directly. Neither main nor renderer parses code or receives a whole graph.

Use a new `src/code-map-host` with `UtilityHost`, an entry in the Electron build, and explicit ESLint/TypeScript boundaries. Reuse `@parcel/watcher` in this host initially. A separate watch subscription is an intentional first-release cost: sharing the current Git watcher would require generalizing ownership, ignores, event types, and support for Git-disabled projects. Do not create both a new watch feed in Workspace Host and duplicate subscriptions in Code Map Host.

Use one writer per checkout and initially one active build across the host. Prioritize queried/active checkouts, then other enabled projects fairly. Yield between bounded parse batches; use an interruptible worker or terminate/restart the host for a parser exceeding its watchdog. Do not run arbitrary project build scripts or language servers. A parser process is workload isolation, not a complete OS security sandbox.

## Settings and persistence

Proposed optional settings shape:

```ts
codeMap?: {
  enabled: boolean;           // absent means false
  excludedPaths?: string[];  // project-relative glob patterns
  ignoreInGit?: boolean;      // absent means true: "Keep .oxy out of Git"
}
```

Pause is runtime state in v1; reopening resumes enabled projects and reconciles first. Hard resource limits are internal defaults until measurement justifies user controls. Runtime status and graph data do not belong in `projects.json`. Add schema defaults/migration tests and preserve this field in all project-settings draft/save paths.

If phase 6 ships, memory settings extend this object as specified in [learning and context](learning-and-context.md#settings-and-user-control). The disposal rules below apply only to derived structural data, never to durable memory. Pausing updates prevents new automatic learning admission that requires current evidence; explicit stale context may expose applicable-at-checkpoint knowledge with its age, never label it current.

Storage location (round three): `<checkout root>/.oxy/code-map/`, specified in [oxy-directory](oxy-directory.md). Each checkout (project root, Ensemble worktree) has its own folder, so no separate checkout key is needed for storage; the service still identifies checkouts by canonical real root plus project identity. Graph symbols use root-relative POSIX paths, while cache identity honors filesystem case rules (including case-sensitive directories on Windows). Do not globally lowercase paths. Resolve junctions/symlinks when establishing containment; do not follow links outside the registered root.

Store a manifest, per-file extraction cache records, the deterministic `graph.json` and `MAP.md` as described in [oxy-directory](oxy-directory.md#writing-rules): atomic temp-and-rename writes, a fixed publication order, manifest hash validation on start, Windows rename retries, and rebuild of invalid or version-mismatched data. The host keeps the last good graph and its search index in memory; readers pin that in-memory generation for the full request.

Start with JSON and in-memory lookup/adjacency indexes. Avoid storing complete source bodies twice: keep symbol signatures and bounded lexical terms; read excerpts from disk only after verifying their hashes. Disk and memory limits must yield visible partial coverage or a recoverable limit error, never a silently truncated “complete” graph. Cache is regenerable; migrations can discard incompatible snapshots without touching source files.

## Graph model and extraction

| Entity   | Required information                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------ |
| File     | ID, relative path, language, content hash, byte size, parse state, package/scope ID.                   |
| Symbol   | ID, file ID, kind, name, qualified lexical owner, signature, export state, source span.                |
| Edge     | Source, target or unresolved target descriptor, relation, evidence span, resolution provenance.        |
| Snapshot | Generation, checkout identity, configuration versions, coverage, pending changes, last reconciliation. |

Node IDs derive from relative path, kind, qualified owner/name, and a deterministic duplicate/overload discriminator; no line number as the primary identity. Anonymous nodes may need a location discriminator and may change IDs when edited. IDs are stable enough within unchanged structure, not guaranteed across arbitrary refactors. Cursors include generation; stale IDs return `SYMBOL_NOT_FOUND` or `SNAPSHOT_CHANGED`, not a name-based guess.

Define source locations centrally: 1-based lines and 0-based UTF-16 columns for consumers, with byte offsets retained inside extraction. Convert parser offsets explicitly and test Unicode, CRLF, and BOMs. Do not equate parser byte columns with Monaco/LSP columns.

Initial node kinds: file, function, method, class, interface, type, enum, variable. Relations: `contains`, `imports`, `calls`, `references`, `extends`, `implements`; each extractor advertises actual supported relations. Provenance values: `syntax`, `binding`, `heuristic`, `unresolved`; future semantic enrichment may add `semantic`. These are evidence categories, not calibrated probabilities. Default impact traversal excludes heuristic edges; callers can request them separately.

Add derived directory/package grouping for overview queries, with deterministic IDs and counts. Grouped import edges summarize existing edges; they do not assert architectural ownership or runtime communication. Keep this projection distinct from B's learning/evidence nodes and links. A TS type-only import, a runtime import, and a call are different evidence; retain that distinction in extraction and traversal filters. Cross-process IPC, event subscriptions, dynamically registered tools, and dependency injection are especially relevant to Oxytocin but remain unresolved until an explicit tested extractor supports them. Do not claim that a syntax graph captures the app's entire runtime architecture.

Per-language rules for TS/JS, C#, Go, Java and Python are in [languages](languages.md). For TS/JS, implement original extraction rules for declarations, arrow functions, exports, imports, common static calls, and class members. Resolve lexical scope/shadowing and explicit imported bindings first. Support relative imports, extension/index lookup, static re-exports, and local package boundaries. Parse tsconfig path mappings and package metadata as data without executing configuration. Unsupported aliases, dynamic imports, computed property calls, dependency injection, event buses, and runtime dispatch remain unresolved and contribute diagnostics. Do not infer a call just because another file has a unique matching name.

Use bundled, version-pinned WASM runtime/grammars. Never fetch grammars on first use. The implementation spike determines the build asset layout and ABI pairing. Add additional languages only with their extraction/resolution fixtures and honest coverage descriptions.

## Enumeration and update algorithm

1. Register watching before the initial scan and retain events arriving during it. Enumerate saved files, including eligible untracked files. Honor `.gitignore` semantics when available plus Code Map exclusions; non-Git folders must work. Explicitly exclude `.git`, dependencies, generated outputs, binaries, likely secret files such as `.env` and private keys, app caches, and every `.oxy` folder. Do not assume `.gitignore` is a complete secret filter. Tests remain indexed but are labeled for ranking.
2. Treat submodules/nested repositories as boundaries in v1; report skipped roots. A project rooted at a package does not silently expand to its parent repository. Unsupported files contribute counts, not fabricated symbol nodes.
3. Coalesce create/update/delete events by path. Initial target: 300 ms quiet debounce with a 2 s maximum scheduling delay; bulk checkout events collapse into reconciliation. These are tuning targets, not measured results.
4. Read/hash affected files; parse only changed content or files invalidated by extractor/config versions. Atomic saves, renames, and deletes must remove old nodes and incoming/outgoing edges. Rename can initially be represented as delete plus create.
5. Assemble all cached extraction records and resolve the graph afresh for the first release. This simpler O(nodes + relation candidates) pass prevents stale cross-file bindings when an export changes. Measure it before implementing reverse-dependency invalidation. “Incremental” here means changed-file parsing, not a promise of sublinear total updates.
6. Track an event sequence at build start/end. Publish a coherent generation; preserve newer pending changes and schedule another update. Read/stat/hash races retry within a bound; continuously changing files are marked partial. A filesystem without atomic snapshots cannot provide a globally instantaneous view.
7. Reconcile on host restart, app resume/focus, branch/index changes, watcher errors/overflow, ignore/config changes, and periodically (initial targets, FR-UPD-3: every 60 seconds for the active project and projects with running terminals, every 10 minutes for other enabled projects, a full content-hash audit every 30 minutes and at start). Unknown watch state requires a full reconciliation. Limit active work and avoid repeated full scans for duplicate triggers.

Start with a 2 MiB per-file cap, 50,000 eligible files, 500,000 nodes, 2,000,000 edges, and a 512 MiB serialized cache cap per checkout. These are proposed protective ceilings, not a performance guarantee. Abort allocations before exceeding bounds, report coverage/limit reasons, and let users narrow exclusions. Revisit limits after the benchmark fixture is measured.

## Freshness contract

Before each query, drain known events and perform a serialized metadata reconciliation (coalesce concurrent probes). Hash dirty/new/stat-changed files and periodically audit all content; explicit **Rebuild** always rehashes everything. A fast metadata probe cannot detect every same-size, same-timestamp edit when the watcher misses it. Report verification mode and last full hash audit; never call that a cryptographic proof of current contents.

`freshness: "latest"` is the default: wait for a generation covering observed changes, within a 2 s query-refresh budget. If no such generation is ready, return a typed `INDEX_UPDATING` result with retry guidance, not an empty result. `"allow-stale"` may return the last good generation, explicitly marked stale with pending/unknown state. `"verified"` requests full content-hash reconciliation and may return `INDEX_UPDATING` while that completes. Paused indexes allow only explicit stale reads. No graph ever returns “no matches” when indexing has not completed.

Freshness metadata includes `generation`, `state`, `stale`, `verification` (`metadata` or `content-hash`), `checkedAt`, `lastFullHashAt`, `pendingFiles`, `coverage`, and warnings. `checkedAt` describes a checkpoint, not the instant of receipt by the agent. Before returning source excerpts, revalidate the selected file hash; retry or omit mismatched excerpts with a diagnostic. Cancellation cancels the caller's wait, not another caller's shared build.

## Agent API

Extend the existing MCP tool registry/policy system; add no transport or authentication scheme. List map tools when at least one project has mapping enabled and notify on availability changes. Every call still checks the selected project's settings. Use compact JSON in the existing text content result for v1; do not require a transport upgrade for structured output.

| Proposed tool         | Inputs beyond checkout selection                                                                              | Output                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `oxy_code_map_status` | none                                                                                                          | State, coverage, freshness, supported languages, limits.                                |
| `oxy_repo_map`        | optional `pathPrefix`, `maxChars`, `freshness`                                                                | The `MAP.md` sections (layout, entry points, hubs, public API) for the whole checkout or a subtree. |
| `oxy_find_code`       | `query`, optional `pathPrefix`, `limit`, `maxChars`, `freshness`                                              | Ranked files/symbols with signatures, spans, match evidence, optional bounded excerpts. |
| `oxy_file_outline`    | relative `path`, `maxChars`, `freshness`                                                                      | File exports, definitions, imports, source spans.                                       |
| `oxy_code_relations`  | `symbolId` or relative `path`, `direction`, `relations`, `depth`, `includeHeuristic`, `maxChars`, `freshness` | Bounded neighbors and relation evidence; incoming edges provide an impact estimate.     |

Require an explicit `cwd` or `project` for ordinary map queries, unless a validated terminal mapping establishes an unambiguous checkout. Never silently use the active UI project. If `cwd` is explicit, resolve the longest registered containing checkout; reject conflicting explicit `cwd`/`project`. Project selection alone means its main root. Register Ensemble-managed worktrees with the owning project, inherit opt-in/exclusions, but index them independently. Unregistered arbitrary paths cannot trigger indexing.

The main Hub bearer token currently grants broad app tool access: this proposal does not claim per-agent isolation on that endpoint. Keep existing policy checks. For Ensemble, extend the bridge with an explicit allowlist of map tools; derive checkout from the authenticated role/task, not user-provided selectors or a spoofable terminal header. Extend role context if necessary, and reject path escapes. Revocation/removal cancels access and outstanding requests. A tool list alone is not authorization.

Strict selection is implemented for Code Map tools only; existing core tools keep their current behavior.

Validate all arguments with zod. Proposed bounds: query length 2,000 characters; limit 1–50 (default 8); depth 1–3 (default 1); output 2,000–24,000 characters (default 8,000). Bound visited nodes/edges separately (initially 2,000/5,000). Include `truncated` and refinement guidance; never treat a bounded impact set as exhaustive. Validate output schemas too. Paths are relative, normalized, and rechecked against canonical containment before reads; exclusions also apply to direct outline requests and exports.

Search v1 uses identifier splitting, exact name/path boosts, signature terms, and modest nearby-symbol expansion. Prefer multiple relevant files over many symbols from one file; let `pathPrefix` constrain monorepo packages. Do not implement PageRank until it improves a labeled retrieval corpus. “No matches” suggests ordinary text search; the map must complement access to source.

Relations responses include explicit node/edge records rather than only prose, so agents can traverse a subgraph using IDs and inspect each edge's evidence. A compact `whyIncluded` field explains lexical or neighbor selection. Graph layout coordinates do not belong in these agent results. Phase 6 (learnings, if confirmed) adds `oxy_task_context`, `oxy_propose_learning`, and `oxy_learning_feedback` without changing the meaning of structural edges. The visualizer phase exposes bounded projections through the public plugin API, with a separate visual payload budget.

Copyable agent rule (original wording; phase 1 version in the [implementation plan](implementation-plan.md#18-ui-the-user-visible-commit-of-phase-1)):

> When Code Map is available, read `.oxy/code-map/MAP.md` first, then use oxy_find_code with your working directory to locate relevant code. Use oxy_file_outline and oxy_code_relations for structure and likely dependencies. Check freshness, coverage, and resolution evidence; read current source before editing. Missing edges do not prove that code is unused. Fall back to normal search when results are incomplete or unavailable.

Treat source text/comments as untrusted data, never instructions. MCP delivery is local, but snippets placed in an agent's context may be sent to that agent's configured model provider; “local indexing” must not be marketed as a guarantee that agent usage is offline. Log timing/counts/errors without source bodies or bearer tokens. Avoid automatically sending whole graphs or large maps on every prompt.
