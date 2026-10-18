# Code Map: third-round research and owner decisions

Research date: 2026-10-18. Baseline: Oxytocin `cdee9fe` (package `0.9.9`, plugin API `0.1.9`), clean working tree. Trail-Code
was re-checked through its public GitHub page on the same date; its source was not re-downloaded or run.

Rounds one and two answered _how_ a structural index and a learning layer could work. This round turns the research into
a product: the owner's brief fixes the scope, a few earlier recommendations are reversed, and the result is captured in
[requirements](requirements.md), the [`.oxy` directory specification](oxy-directory.md) and the rewritten
[implementation plan](implementation-plan.md).

## Owner brief (2026-10-18)

The owner described the feature as follows (translated from Polish, wording kept close to the original):

1. The feature is modelled on the open-source project [Trail-Code](https://github.com/trailhq/Trail-Code).
2. After **Code Map** is enabled for a project, Oxytocin creates an **`.oxy` directory in the project**, and that directory
   is **added to `.gitignore`**.
3. Oxytocin builds a **graph** of the code, possibly **in the background** so that it does not get in the way.
4. Graph building is **deterministic**: it is done by Oxytocin's own scripts, **not by AI**.
5. Agents work more efficiently with the graph because they know how to search for code more optimally.
6. Code Map **runs in the background from time to time and updates itself** so that it stays current.
7. There is a **visualizer** of the graph.

## Owner answers to the open questions (2026-10-18)

- **Q1 — learnings:** wanted. They are phase 6 of the product.
- **Q2 — `.gitignore`:** `.oxy` is always in `.gitignore` by default, but the user can turn that off.
- **Languages:** JavaScript/TypeScript and C# matter most now; add a few more if that is not complicated.
- Push everything to the main branch (the owner wrote “master”; the repository's only branch is `main`).

### Follow-up research: how expensive are more languages?

Checked on the npm registry the same day: the official grammar packages `tree-sitter-javascript` 0.25.0,
`tree-sitter-typescript` 0.23.2, `tree-sitter-c-sharp` 0.23.5, `tree-sitter-python` 0.25.0, `tree-sitter-go` 0.25.0,
`tree-sitter-java` 0.23.5, `tree-sitter-rust` 0.24.0 and `tree-sitter-php` 0.24.2 are MIT-licensed and each contains a
**prebuilt `.wasm`** grammar next to its native Node bindings; `web-tree-sitter` 0.27.1 is MIT. No Emscripten build is
needed, so a language costs an extractor, resolution rules and fixtures — not toolchain work. C# is the largest grammar
(5.35 MB WASM). Resolution effort differs a lot: Go and Java have explicit module systems, Python is dynamically typed, C#
resolves through namespaces and partial types. Details and the resulting plan are in [languages](languages.md).

## What changes against rounds one and two

| Earlier recommendation                                                   | Decision now                                                                                                                                                       | Why                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canonical cache in `<userData>/code-map/<checkoutKey>/`, outside the repo | Canonical store is **`<checkout root>/.oxy/code-map/`**.                                                                                                           | Owner decision (brief 2). It also gives every checkout (Ensemble worktree, second clone) its own map without a checkout-key scheme, and lets any agent read the map as plain files, with or without MCP.                |
| “No automatic changes to `.gitignore`”                                    | Enabling Code Map appends `/.oxy/` to the project's `.gitignore` (Git projects), and `.oxy/.gitignore` containing `*` is always written as a safety net.          | Owner decision (brief 2). The nested `.gitignore` keeps worktrees and repositories whose root `.gitignore` edit was reverted clean.                                                                                      |
| MCP is the only agent surface                                            | MCP tools **plus** a deterministic, bounded `.oxy/code-map/MAP.md` that any agent can read.                                                                        | Brief 5: every agent should benefit, including agents not connected to the Oxytocin MCP Hub. Trail ships both (Markdown projections and MCP tools).                                                                      |
| Self-learning context (milestone B) is part of the requested scope        | Learnings stay in scope as **phase 6**, after the deterministic map, agent tools and visualizer (owner answer to Q1).                                              | Learnings are agent-written (not deterministic) and are the largest risk; building them on top of a measured map keeps both honest.                                                                                       |
| Release order A (structure) → B (memory) → C (visualizer)                 | Map on disk → agent tools → visualizer → insights and languages → (learnings).                                                                                     | Each step is a complete, usable state (`CLAUDE.md` rule 4) and the visualizer is an explicit requirement.                                                                                                               |
| Generation directories with a pointer file                                | One `graph.json` replaced atomically, plus an extraction cache keyed by content hash.                                                                              | Files in `.oxy` are now a public, agent-readable artefact; one stable file name is simpler for agents and the visualizer. The host keeps the last good graph in memory for pinned reads.                                |

Everything else from rounds one and two still applies: Tree-sitter WASM in a supervised utility host, original extractors
(no copied Trail code), freshness metadata on every answer, strict checkout selection for MCP calls, bounded results,
honest coverage, no claims of guaranteed savings.

## Trail-Code today (public page, 2026-10-18)

The current public README of Trail-Code (now published as `@trailhq/trail-code`, MIT) confirms the direction of the brief:

| Aspect          | Trail-Code                                                                                                                                                                                                     | Consequence for Oxytocin                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-repo storage | `graft/` holds the rebuildable map (Markdown nodes and `graft/.graph/wiring.json`); `trail init` adds `graft/` to `.gitignore`. Repository learnings in `.trail/learnings/` are committed; personal ones live in `~/.trail/`. | Same pattern as the brief: derived data lives in the project and is ignored by Git. Oxytocin uses one dot-directory, `.oxy/`, namespaced per feature.           |
| Freshness       | No daemon. Every query compares the working tree with the last build's fingerprint and rebuilds what changed; Claude Code hooks resync after edits and at the end of a turn.                                    | Oxytocin can do better because it is already running: a watcher and periodic reconciliation update the map ahead of queries, and queries still check freshness. |
| Agent surface   | MCP tools `trail_find_code`, `trail_file_api`, `trail_trace_calls`, `trail_find_all`, `trail_repo_map`, `trail_check_freshness`; instruction files and hooks written by `trail init` (it never touches `CLAUDE.md`). | Oxytocin's tool set mirrors these jobs (find, outline, relations, repo map, status). It does not install hooks or edit instruction files without a user action. |
| Visualizer      | `trail viz` serves a viewer on localhost with Context, Code and Outline tabs; it can export a self-contained `index.html` and live-reloads.                                                                     | Oxytocin's visualizer is a built-in plugin view (no local server), with Overview, Neighborhood, File and Search views plus a Changes overlay.                     |

These are documented capabilities, not measured behaviour. Upstream benchmark numbers (for example 46% fewer tool calls)
remain upstream claims; see [validation](validation.md#does-it-actually-help-agents).

## New findings in the Oxytocin baseline

| Location                                                                       | Finding                                                                                                                                                                                       | Consequence                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workspace-host/git/repo-watcher.ts`, `src/shared/domain/settings.ts`      | The Git watcher ignores `git.ignoredFolders` (default list, user-editable). Writes to `.oxy/` would otherwise trigger a working-tree refresh after every Code Map publication.                  | Add `.oxy` to an always-ignored list in the watcher (not only to the editable default), with a test that a Code Map write causes no `fs` refresh.                                                 |
| `src/workspace-host/files/project-files.ts`                                    | `findFiles` already enumerates `git ls-files --cached --others --exclude-standard`; `resolveInside` and `assertWritable` implement project-relative path containment.                          | Reuse the same semantics in the Code Map host (enumeration of tracked + untracked, non-ignored files; containment checks). Do not route Code Map I/O through the Workspace Host.                    |
| `src/main/services/ensemble/ensemble-service.ts`                               | Worktrees are created outside the repository by default (`<repo>.worktrees/<slug>-<id>` next to it, or `ensemble.worktreeRoot`). A project in a repository subfolder maps to the same subfolder of the worktree. | Each worktree gets its own `<worktree project path>/.oxy/`. Oxytocin never edits `.gitignore` inside a worktree (that would show up as an agent change); `.oxy/.gitignore` keeps it clean.           |
| `src/main/hosts/hosts.ts`, `src/main/app/paths.ts`, `electron.vite.config.ts`  | Hosts are an explicit `HostEntry` union (`ptyHost`, `workspaceHost`, `pluginHost`, `connectionsHost`) with build inputs and inspect ports.                                                    | A `codeMapHost` entry follows the same pattern (inspect port 9235 or the next free one), started on demand when the first project enables Code Map.                                                |
| `src/renderer/src/features/projects/ProjectSettingsDialog.tsx`                 | Tabs are a closed `TabId` union; `project-settings-model.ts` rebuilds the settings object from a draft.                                                                                       | Add a `code-map` tab and make the draft round-trip `settings.codeMap`, so saving another tab never drops it.                                                                                        |
| `packages/plugin-api/index.d.ts`, `src/shared/domain/plugin.ts`                | Plugin API `0.1.9`; `ui.openInEditor(path, line, column)` exists; permissions are a closed list without a Code Map entry.                                                                       | The visualizer needs a new `oxy.codeMap` namespace and a `code-map.read` permission (plugin API `0.2.0`).                                                                                           |
| `package.json` `licenses:check`                                                | Allowlist: MIT, ISC, BSD, Apache-2.0, 0BSD, MPL-2.0 and a few others.                                                                                                                          | `web-tree-sitter`, `tree-sitter-javascript`, `tree-sitter-typescript` and Cytoscape.js are MIT-licensed upstream; verify the exact shipped versions with `npm run licenses:check`.                 |
| `.prettierignore`                                                              | `docs/` and `*.md` are not formatted by Prettier.                                                                                                                                             | `MAP.md` and these documents are outside lint; `MAP.md` determinism is enforced by the Code Map's own tests.                                                                                        |

## Why a file the agent can read, and why MCP as well

- `MAP.md` works with any agent and any client, including agents started outside Oxytocin and clients without MCP. It
  answers the first question of almost every session (“what is where?”) in one bounded read.
- MCP tools answer the follow-up questions precisely (find a symbol, list a file's API, trace callers) with freshness
  metadata, without the agent loading a large file.
- `.oxy/` is ignored by Git, so `rg`, `git grep` and the search tools of Claude Code and Codex skip it by default: the map
  does not pollute the agent's ordinary searches. Agents reach it through the explicit path in the instructions.
- Research on static context files ([Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988v3)) found that more
  always-loaded context can raise cost without improving success. Hence `MAP.md` is bounded (proposed 32 KiB), is read on
  demand, and is never injected into every prompt by Oxytocin.

## Decisions taken in this round

| Question                          | Decision                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does the map live?          | `<checkout root>/.oxy/code-map/`, specified in [oxy-directory](oxy-directory.md).                                                                                                |
| How is it kept out of Git?        | By default `/.oxy/` is appended to the project's `.gitignore` (Git projects) and `.oxy/.gitignore` contains `*`; the user can turn this off.                                     |
| What does “deterministic” mean?   | The same saved files, settings and Oxytocin version produce byte-identical `graph.json` and `MAP.md` on every platform. No model, no network, no clock or absolute path in them. |
| When does it update?              | Watcher-driven (debounced), periodic reconciliation, on app start/focus and branch switches, and a freshness check before each agent query. Details in the requirements.          |
| How do agents use it?             | `MAP.md` + five MCP tools through the existing Hub + a copyable or user-inserted instruction block.                                                                              |
| Visualizer?                       | Built-in plugin `oxytocin.code-map-visualizer` on a public `oxy.codeMap` API, Cytoscape.js as the first renderer candidate.                                                       |
| Languages?                        | JS/TS (phase 1a) and C# (phase 1b) first; Go, Java, Python in phase 5; Rust and PHP on demand ([languages](languages.md)). Every other file appears as a file node.                |
| Learnings?                        | Phase 6, confirmed by the owner; storage in `.oxy/learnings/`.                                                                                                                   |
| Can `.oxy` be committed?          | Yes, if the user turns **Keep `.oxy` out of Git** off; machine-local files stay ignored ([oxy-directory](oxy-directory.md#option-off)).                                          |
