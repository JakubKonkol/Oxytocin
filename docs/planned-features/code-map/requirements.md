# Code Map — business requirements

Status: requirements for implementation, derived from the owner's brief of 2026-10-18 and research rounds one to three.
Nothing here is shipped. Where this document and older research disagree, this document and
[research round three](research-round-3.md) win.

## 1. Problem

Developers using Oxytocin run AI coding agents (Claude Code, Codex, Gemini CLI and others) in its terminals. Every new
agent session starts without knowing the repository. Before it can make a change, the agent spends tool calls and tokens
on orientation: listing directories, grepping for names, opening files only to see what they export, following imports by
hand, and guessing who calls a function. The work is repeated in every session and in every parallel agent, it gets more
expensive as the repository grows, and missed callers lead to broken changes.

Oxytocin already knows the user's projects, watches their files, hosts the agents' terminals and runs an MCP server the
agents talk to. It is in the right place to maintain a map of the code once and hand it to every agent.

## 2. Product vision

> Enable **Code Map** for a project and Oxytocin keeps a deterministic, always-current map of its code in the project's
> `.oxy` folder. Agents use the map to find the right code with fewer, more targeted searches, and you can explore the same
> map visually.

Business goals:

| ID  | Goal                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| G1  | Lower the exploration cost of agents (tool calls, input tokens, time) on mapped projects without lowering task correctness. |
| G2  | Zero setup cost: one switch per project; no API key, no model cost, no CLI to install, no network access, works offline.    |
| G3  | Never disturb the user's work: indexing happens in the background without noticeable lag in terminals, editor or Git.      |
| G4  | Help people understand code bases (onboarding, reviewing agent changes) through a visual explorer of the same map.           |
| G5  | Differentiate Oxytocin from a plain terminal: projects become “agent-ready” with one click.                                  |

## 3. Users and key scenarios

| Persona                            | Need                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P1 — Agent-heavy developer (primary) | Runs one or more agents daily on own repositories; wants faster, cheaper, more accurate agent sessions.      |
| P2 — Developer in an unfamiliar repo | Needs to understand structure, entry points and dependencies quickly.                                       |
| P3 — Reviewer of agent work         | Uses Changes, Task or Ensemble; wants to see what a change touches and what could depend on it.             |

Scenarios the feature must support end to end:

- **S1 — Enable.** P1 opens Project settings → Code Map, turns it on and confirms. Oxytocin creates `.oxy/`, adds it to
  `.gitignore`, and shows progress. A minute later (typical repository) the map is ready. P1 commits the `.gitignore` line.
- **S2 — Agent session.** P1 starts Claude Code in an Oxytocin terminal. The agent reads `.oxy/code-map/MAP.md` or calls
  `oxy_find_code`, goes straight to the right files, uses `oxy_code_relations` to check callers before changing a function,
  and reads only the source it needs.
- **S3 — Stays current.** The agent edits ten files, P1 switches branch, and a teammate's pull adds a package. The map
  follows each change in the background without P1 doing anything; an agent query right after an edit sees the edit.
- **S4 — Explore.** P2 opens **Code Map** from the project, sees the project's folders as clusters with their dependencies,
  drills into a folder, selects a file, sees what it imports and who imports it, and opens a symbol in the editor.
- **S5 — Review.** P3 opens the visualizer's Changes overlay: uncommitted (or task) changes are highlighted together with
  the indexed code that potentially depends on them.
- **S6 — Turn off.** P1 disables Code Map. Background work stops, agent tools stop answering for that project, and P1 can
  delete the `.oxy/code-map` data with one button.

## 4. Scope

**In scope (product v1 = phases 1–4 of the [implementation plan](implementation-plan.md))**

- Per-project opt-in, `.oxy/` directory and `.gitignore` handling.
- Deterministic graph of files, folders, symbols and their relations, built by Oxytocin's own code (no AI).
- Symbol-level extraction for TypeScript and JavaScript; file-level nodes for every other text file.
- Background build and continuous updates (watcher + periodic reconciliation + freshness check on query).
- Agent access through `MAP.md` and MCP tools of the existing Oxytocin MCP Hub; copyable agent instructions.
- Visualizer as a built-in plugin, with a public plugin API for the map.
- Status, diagnostics and controls in Project settings.
- Ensemble/Task worktrees get their own maps.

**Later (phases 5–6, separate decisions)**

- Symbol extraction for more languages (Python, Go, Rust, C#, Java first).
- Self-learning context (agent-proposed learnings with evidence), see [learning and context](learning-and-context.md).

**Out of scope**

- Any AI/LLM use while building or updating the map (summaries, embeddings, classification).
- Uploading code or the map anywhere; team sync; cloud services.
- Running project code, build scripts, package managers or language servers.
- Indexing unsaved editor buffers; indexing while Oxytocin is closed.
- Installing hooks into agent clients or editing `CLAUDE.md`/`AGENTS.md` without an explicit user action.
- Guarantees that the graph is a complete runtime call graph.

## 5. Functional requirements

Priority: **M** = must (release blocker for the phase), **S** = should, **C** = could. Phase numbers refer to the
[implementation plan](implementation-plan.md).

### 5.1 Enabling and lifecycle (FR-EN)

| ID      | Requirement                                                                                                                                                                                                            | Prio | Phase |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-EN-1 | Project settings get a **Code Map** tab with an **Enable Code Map** switch. Code Map is off for existing and new projects until the user turns it on.                                                                  | M    | 1     |
| FR-EN-2 | Turning it on shows a one-time confirmation that names what will happen: create `.oxy/` in the project folder, add `/.oxy/` to `.gitignore`, index saved files in the background.                                      | M    | 1     |
| FR-EN-3 | Enabling starts the first build immediately; no agent session is needed.                                                                                                                                              | M    | 1     |
| FR-EN-4 | **Pause updates / Resume updates** stops and restarts background work without deleting data; while paused, agents get explicitly stale answers only.                                                                 | S    | 1     |
| FR-EN-5 | **Rebuild** discards the extraction cache and rebuilds from scratch; it is cancellable.                                                                                                                                | M    | 1     |
| FR-EN-6 | Disabling stops all background work and watches for the project, makes agent tools refuse that project, and keeps `.oxy/code-map/` for a fast re-enable.                                                              | M    | 1     |
| FR-EN-7 | **Delete map data** removes `.oxy/code-map/` (and `.oxy/` if it is then empty apart from Oxytocin's own files). It never touches files outside `.oxy/`.                                                              | M    | 1     |
| FR-EN-8 | The setting is stored in the project's settings (`settings.codeMap`) and survives restarts; after a restart enabled projects reconcile before answering agents.                                                       | M    | 1     |
| FR-EN-9 | Removing a project from Oxytocin stops its Code Map. Its `.oxy/` stays on disk (it belongs to the user's folder); the removal dialog says so.                                                                         | M    | 1     |
| FR-EN-10 | Changing the project's root folder stops the old map and builds a new one in the new root.                                                                                                                           | M    | 1     |

### 5.2 `.oxy` directory and Git (FR-DIR)

Details in the [`.oxy` directory specification](oxy-directory.md).

| ID       | Requirement                                                                                                                                                                                                          | Prio | Phase |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-DIR-1 | Oxytocin creates `<project root>/.oxy/` with `.gitignore` (content `*`), `README.md` (what the folder is, that it is safe to delete) and `code-map/`.                                                                 | M    | 1     |
| FR-DIR-2 | In a Git project, enabling appends `/.oxy/` (with a comment line) to `<project root>/.gitignore`, creating the file if needed, unless an equivalent entry already exists. Existing content, line endings, BOM and final newline are preserved. | M    | 1     |
| FR-DIR-3 | Oxytocin never edits `.gitignore` in Ensemble/Task worktrees or in any folder other than the enabled project's root.                                                                                                 | M    | 1     |
| FR-DIR-4 | Oxytocin never writes outside `.oxy/` except the single `.gitignore` edit of FR-DIR-2 (and, on explicit user action, the instruction block of FR-AG-7).                                                             | M    | 1     |
| FR-DIR-5 | The map never contains absolute paths, user names, machine names, timestamps of files or secrets read from files; paths are project-relative POSIX paths.                                                          | M    | 1     |
| FR-DIR-6 | Writes in `.oxy/` do not trigger Oxytocin's own Git status refresh, file watcher or Code Map rebuild loops.                                                                                                          | M    | 1     |
| FR-DIR-7 | If `.oxy/` cannot be created or written (read-only folder, permissions), Code Map shows an error state with the reason; it does not silently write elsewhere.                                                      | M    | 1     |
| FR-DIR-8 | Only one Oxytocin instance writes a given `.oxy/code-map/` at a time; a second instance (for example a development build) reads it or reports that another instance owns it.                                        | S    | 1     |

### 5.3 Building the graph (FR-BLD)

| ID       | Requirement                                                                                                                                                                                                         | Prio | Phase |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-BLD-1 | Building is deterministic: the same saved files, Code Map settings and Oxytocin version produce byte-identical `graph.json` and `MAP.md` for identical file contents, on Windows, macOS and Linux, cold or incremental.                        | M    | 1     |
| FR-BLD-2 | No AI, network or project-code execution is used. Configuration files (`package.json`, `tsconfig.json`/`jsconfig.json`) are read as data only.                                                                    | M    | 1     |
| FR-BLD-3 | Indexed files: saved working-tree files that Git would track or show as untracked (tracked + untracked, not ignored), or all files in non-Git folders, minus built-in exclusions and user exclusions.             | M    | 1     |
| FR-BLD-4 | Built-in exclusions: `.git`, `.oxy`, the folders in `git.ignoredFolders` defaults (`node_modules`, `dist`, `build`, `out`…), binary files, files over 2 MiB, lock files, likely secrets (`.env*`, `*.pem`, `*.key`, `id_rsa*`…). | M    | 1     |
| FR-BLD-5 | Users can add exclusion patterns (project-relative globs) in the Code Map tab.                                                                                                                                      | M    | 1     |
| FR-BLD-6 | Nodes: folder groups, files (all indexed files, with language and size), and for TS/JS: functions, methods, classes, interfaces, type aliases, enums, exported variables, with name, kind, signature, export state and source span. | M    | 1     |
| FR-BLD-7 | Relations: `contains` (folder → file → symbol), `imports` (file → file, with type-only flag), `exports`/re-exports, `calls`, `extends`, `implements`, `references` where statically resolvable.               | M    | 1     |
| FR-BLD-8 | Every relation records how it was resolved (`syntax`, `binding`, `heuristic`) and where (source line). Unresolved imports/calls are counted and listed, never guessed into a wrong edge.                          | M    | 1     |
| FR-BLD-9 | Imports resolve relative paths, extension and `index` lookup, `tsconfig` `paths`/`baseUrl`, and npm-workspace packages inside the project; external packages become `package` nodes without indexing their code. | M    | 1     |
| FR-BLD-10 | Coverage is reported: indexed, skipped (with reason), unsupported-language and failed files; unresolved relation counts.                                                                                          | M    | 1     |
| FR-BLD-11 | A syntax error in a file keeps the file's last good symbols marked as stale for that file, and reports it; it does not fail the whole build.                                                                     | S    | 1     |
| FR-BLD-12 | Protective limits (initial: 50,000 indexed files, 500,000 symbols, 2,000,000 edges, 512 MiB of map data) stop the build with a visible “limit reached — add exclusions” state instead of a silently partial map. | M    | 1     |
| FR-BLD-13 | Symbol extraction for Python, Go, Rust, C# and Java, each with its own fixtures and coverage description.                                                                                                         | S    | 5     |

### 5.4 Background updates (FR-UPD)

| ID       | Requirement                                                                                                                                                                                                      | Prio | Phase |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-UPD-1 | All indexing runs in a separate Code Map utility process at below-normal OS priority, in bounded batches; the main process, terminals and renderer never parse code.                                          | M    | 1     |
| FR-UPD-2 | A file watcher picks up saves, creations, deletions and renames; changes are debounced (initial: 300 ms quiet, at most 2 s delay) and only changed files are re-parsed.                                         | M    | 1     |
| FR-UPD-3 | Periodic reconciliation (“from time to time”) compares the folder with the map and repairs anything the watcher missed: every 60 s for the active project and projects with running terminals, every 10 min for other enabled projects, and a full content-hash audit every 30 min and at app start. | M    | 1     |
| FR-UPD-4 | Branch switches, `git pull`, stash/reset and bulk changes collapse into one reconciliation instead of thousands of single-file updates.                                                                       | M    | 1     |
| FR-UPD-5 | Reconciliation also runs on app start, on window focus after sleep/resume, after watcher errors/overflow, and after a change to `.gitignore`, `tsconfig`/`package.json` or Code Map exclusions.               | M    | 1     |
| FR-UPD-6 | One build per checkout at a time; across projects, the active project goes first. A build in progress is never restarted on every keystroke; newer changes queue for the next pass.                            | M    | 1     |
| FR-UPD-7 | Updates never show toasts or steal focus. Progress and errors appear only in the Code Map status (settings tab, project indicator).                                                                           | M    | 1     |
| FR-UPD-8 | An agent query first makes sure observed changes are in the map, waiting at most 2 s; otherwise it gets an explicit “updating” or stale answer, never “no results” from an incomplete map.                    | M    | 2     |

### 5.5 Agent access (FR-AG)

| ID      | Requirement                                                                                                                                                                                                                                  | Prio | Phase |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-AG-1 | `.oxy/code-map/MAP.md` is a deterministic, bounded (initial: 32 KiB) overview: how to use the map, languages and coverage, folder tree with roles and counts, entry points, the most depended-upon files, and the public API of key files.   | M    | 1     |
| FR-AG-2 | The existing Oxytocin MCP Hub offers five read-only tools for Code Map projects: `oxy_code_map_status`, `oxy_repo_map`, `oxy_find_code`, `oxy_file_outline`, `oxy_code_relations` ([design](design.md#agent-api)).                        | M    | 2     |
| FR-AG-3 | Every tool answer carries freshness (generation, stale flag, pending files), coverage and truncation; results are bounded (default 8,000 characters, max 24,000).                                                                          | M    | 2     |
| FR-AG-4 | Tools select the project/checkout from the agent's terminal or explicit `cwd`/`project`; they never fall back to whatever project is active in the UI. Agents in Ensemble worktrees get their worktree's map.                             | M    | 2     |
| FR-AG-5 | New MCP sessions receive a short brief describing the tools; tool descriptions are self-explanatory for already-connected sessions.                                                                                                     | M    | 2     |
| FR-AG-6 | **Copy agent instructions** copies a short rule telling agents to read `MAP.md` first, use the tools, check freshness and fall back to normal search.                                                                                    | M    | 1     |
| FR-AG-7 | **Add to CLAUDE.md / AGENTS.md** inserts (and **Remove** deletes) a marker-fenced instruction block in the chosen file. Only on explicit user action; never automatic.                                                                    | S    | 2     |
| FR-AG-8 | Source text from the map is treated as data, never as instructions; tool logs record timing and counts, not source bodies.                                                                                                              | M    | 2     |

### 5.6 Visualizer (FR-VIS)

| ID       | Requirement                                                                                                                                                                                                       | Prio | Phase |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-VIS-1 | A built-in plugin **Code Map Visualizer** opens as a workspace tab or sidebar panel from the project's context menu, the command palette (“Code Map: Open”) and the Code Map settings tab.                       | M    | 3     |
| FR-VIS-2 | **Overview**: folders/packages as clusters with aggregated import dependencies (count on the edge); expand a cluster to its sub-folders and files.                                                                 | M    | 3     |
| FR-VIS-3 | **Neighborhood**: a selected file or symbol with incoming and outgoing relations, depth 1–3, filterable by relation type and resolution provenance.                                                                 | M    | 3     |
| FR-VIS-4 | **File view**: a file's symbols (outline), its imports and its importers.                                                                                                                                        | M    | 3     |
| FR-VIS-5 | **Search** by file path or symbol name with keyboard navigation; selecting a result focuses it in the graph.                                                                                                     | M    | 3     |
| FR-VIS-6 | A details panel shows the selected node's path, kind, signature, span, incoming/outgoing counts and relation evidence; **Open in editor** jumps to the exact location in Oxytocin's editor.                       | M    | 3     |
| FR-VIS-7 | The view follows map updates without resetting the layout of nodes that still exist, and switches cleanly when the project or checkout changes.                                                                 | M    | 3     |
| FR-VIS-8 | Large maps stay usable: the view requests bounded slices (default 150 nodes / 300 edges, hard 500 / 1,000) and states what was left out; it never renders the whole graph of a large project.                     | M    | 3     |
| FR-VIS-9 | A keyboard-accessible list view shows the same slice; edge types differ by line style and label, not only by colour; light/dark themes follow Oxytocin tokens.                                                    | M    | 3     |
| FR-VIS-10 | **Changes overlay**: highlight files with uncommitted changes (or the changes of a selected Task/Ensemble worktree) and their potential dependents in indexed code.                                              | S    | 4     |
| FR-VIS-11 | **Impact view** for a symbol or file: “Potential dependents in indexed code”, grouped by folder, with a clear note that the list is not exhaustive.                                                              | S    | 4     |
| FR-VIS-12 | Export the current view as SVG/PNG.                                                                                                                                                                             | C    | 4     |
| FR-VIS-13 | The visualizer works only through the public plugin API; agents and indexing keep working when the plugin is disabled.                                                                                         | M    | 3     |

### 5.7 Status and diagnostics (FR-ST)

| ID      | Requirement                                                                                                                                                                                                                     | Prio | Phase |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-ST-1 | The Code Map tab shows the state (`Off`, `Indexing n%`, `Ready`, `Updating`, `Paused`, `Degraded`, `Error`, `Limit reached`), last update, counts (files, symbols, relations), coverage by language, map size and agent access (MCP on/off). | M    | 1     |
| FR-ST-2 | A small indicator next to the project in the sidebar shows Indexing/Ready/Error for enabled projects; hovering shows the summary; clicking opens the Code Map tab.                                                          | S    | 1     |
| FR-ST-3 | Diagnostics list skipped/failed files and unresolved imports (bounded, with “copy” for bug reports) without repeated notifications.                                                                                       | S    | 1     |
| FR-ST-4 | Code Map host health and restarts appear in the existing hosts status (About/diagnostics).                                                                                                                                  | M    | 1     |

### 5.8 Worktrees and multiple checkouts (FR-WT)

| ID      | Requirement                                                                                                                                                                         | Prio | Phase |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| FR-WT-1 | Ensemble/Task worktrees of a Code Map project get their own `.oxy/code-map/` built from the worktree's files, sharing the project's exclusions.                                     | M    | 2     |
| FR-WT-2 | A worktree map is created when the worktree is ready and stopped when it is removed; the main project's map is never returned for a worktree.                                     | M    | 2     |
| FR-WT-3 | The visualizer offers a checkout selector (main folder, active worktrees).                                                                                                          | S    | 4     |

## 6. Non-functional requirements

Targets are initial engineering targets to be confirmed in phase 0 and the [validation](validation.md) experiments; they
are not measured results.

| ID     | Area             | Requirement                                                                                                                                                                                       |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-1  | Performance      | Cold build of a 10,000-file TS/JS repository under 30 s on a documented Windows machine; Oxytocin's own repository under 10 s.                                                                   |
| NFR-2  | Freshness        | A saved one-file edit is in the map (queryable and in `graph.json`) within 2 s (p95) on the 10,000-file fixture.                                                                                 |
| NFR-3  | Query latency    | Warm MCP queries p95 under 200 ms excluding a required refresh.                                                                                                                                   |
| NFR-4  | Non-interference | Terminal input latency and Git status refresh p95 regress by at most 10% during a cold build; no main-process blocking; idle CPU under 1% of one core averaged over 5 minutes.                    |
| NFR-5  | Memory           | Code Map host under 512 MiB resident on the 10,000-file fixture; it releases unused project data when a project is disabled.                                                                      |
| NFR-6  | Disk             | Map data typically under 5% of the indexed source size, hard cap 512 MiB per checkout; extraction cache entries of deleted files are pruned.                                                      |
| NFR-7  | Determinism      | Byte-identical outputs across runs, platforms (path separators, CRLF/LF, case-insensitive file systems), cold vs incremental builds and file enumeration order.                                  |
| NFR-8  | Reliability      | Killing the host or the app during a build never leaves a corrupt `graph.json`; the last good map stays readable; a corrupt or old-schema map is rebuilt automatically.                          |
| NFR-9  | Privacy          | Everything stays on the machine. No telemetry of code or map. Answers given to an agent can reach that agent's model provider — UI copy must not promise otherwise.                              |
| NFR-10 | Security         | No project code execution; paths contained in the project (symlinks/junctions outside the root are not followed); likely secret files are never read; plugin access needs a permission.          |
| NFR-11 | Platforms        | Windows 11 is primary; macOS and Linux supported. Packaged builds work offline with bundled parsers and no compiler toolchain.                                                                   |
| NFR-12 | Accessibility    | Visualizer usable by keyboard (list view), sufficient contrast in both themes, no colour-only encoding.                                                                                          |
| NFR-13 | Licensing        | All new dependencies MIT-compatible (`npm run licenses:check`) and listed in `THIRD_PARTY_NOTICES.md`; no Trail-Code code, queries or texts copied.                                              |
| NFR-14 | Language         | All UI text, `MAP.md`, docs, logs and errors in English.                                                                                                                                         |

## 7. Business rules

- **BR-1** The map is derived data. It can always be deleted and rebuilt; nothing in `.oxy/code-map/` is a source of truth.
- **BR-2** Oxytocin never commits, stages or pushes anything on behalf of Code Map. The `.gitignore` edit is a normal
  working-tree change the user commits.
- **BR-3** “Ready” means the map reflects the files seen at the last checkpoint, not complete semantic knowledge. Missing
  edges never prove that code is unused; the UI and tool texts say “potential dependents in indexed code”.
- **BR-4** No feature flag: Code Map is available to every user as soon as the release containing phase 1 ships; the
  per-project switch is a user preference, not a rollout mechanism.
- **BR-5** No savings claims in the UI or changelog unless measured by the evaluation in [validation](validation.md).
- **BR-6** Agent-facing texts must not tell agents to skip reading current source before editing.

## 8. Success metrics

| Metric                                         | Target                                                                                                     | Source                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Exploration cost on the evaluation task corpus | ≥ 15% lower median exploration tool calls or uncached input tokens, no correctness regression              | Agent evaluation ([validation](validation.md))     |
| Freshness                                      | ≥ 99% of agent queries answered from a map containing all observed changes (latest mode)                   | Code Map host diagnostics in tests and dogfooding  |
| Non-interference                               | NFR-4 met on the benchmark                                                                                 | Performance experiment                             |
| Determinism                                    | 100% byte-identical outputs in the cross-platform CI determinism test                                      | CI                                                 |
| Owner dogfooding                               | Code Map enabled on Oxytocin's own repository and used by agents daily for two weeks without disabling it | Owner feedback                                     |

## 9. Assumptions and constraints

- Oxytocin's architecture rules apply: new utility host, zod at every boundary, no synchronous I/O in main after startup,
  CSS tokens only, every behaviour change tested, E2E for user-visible features, English everywhere, MIT-compatible
  dependencies.
- Agents decide themselves whether to use `MAP.md` and the tools; Oxytocin can encourage (brief, instructions) but cannot
  force them.
- The map covers saved files while Oxytocin runs. After a restart it reconciles before answering.
- TypeScript/JavaScript first because Oxytocin and many of its users' repositories are TS/JS; other files are still
  visible as file nodes.

## 10. Risks

| Risk                                                           | Mitigation                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| WASM parsing too slow or packaging fails in Electron/ASAR      | Phase 0 spike in a packaged Windows build; fallback to the TypeScript compiler API for TS/JS.                 |
| Map adds context but does not reduce agent cost                | Bounded `MAP.md`, on-demand tools, evaluation before claims; tune or trim what agents receive.                |
| Wrong or missing relations mislead agents                      | Provenance per edge, unresolved counts, “not exhaustive” wording, fixtures for every resolver rule.           |
| Background work slows the app                                  | Separate process, low priority, batching, active-project priority, measured non-interference gate.            |
| `.gitignore` edit surprises users or conflicts                  | Explicit confirmation, minimal append, preserved formatting, never in worktrees, nested `.oxy/.gitignore`.     |
| Large monorepos exceed limits                                  | Visible limit state with exclusion guidance; limits revisited after measurements.                             |
| Visualizer unusable on dense graphs                            | Server-side aggregation and bounded slices, list fallback, renderer spike before choosing a library.          |

## 11. Open questions for the owner

| ID  | Question                                                                                                                                         | Proposed default                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Q1  | Is the self-learning layer (agent-proposed learnings) still wanted, and if so after the visualizer?                                              | Yes, as phase 6 after v1 has been evaluated; storage in `.oxy/learnings/`.                               |
| Q2  | Should the enable confirmation offer an opt-out of the root `.gitignore` edit?                                                                    | No opt-out: the brief says `.oxy` is added to `.gitignore`; the nested `.oxy/.gitignore` covers edge cases. |
| Q3  | Should enabling also offer to insert the agent instruction block into `CLAUDE.md`/`AGENTS.md` (still only on click)?                            | Offer it as a separate button in the Code Map tab, not inside the enable confirmation.                    |
| Q4  | Is a global “enable Code Map for new projects” preference wanted?                                                                                | Not in v1; per-project opt-in only.                                                                       |
| Q5  | Which non-TS languages matter most for phase 5?                                                                                                  | Python, then Go, Rust, C#, Java.                                                                         |
