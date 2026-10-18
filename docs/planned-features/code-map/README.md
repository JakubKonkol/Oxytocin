# Code Map

Status: requirements and implementation plan ready (round three, 2026-10-18, including the owner's answers to the open
questions); implementation not started.

**Code Map** is a per-project, opt-in feature modelled on [Trail-Code](https://github.com/trailhq/Trail-Code): when it is
enabled, Oxytocin creates an `.oxy/` folder in the project (added to `.gitignore`) and keeps a **deterministic graph of
the project's code** in it — files, folders, symbols, imports, calls and inheritance — built by Oxytocin's own code, not
by AI. The map updates in the background while Oxytocin runs. Agents use it (through `.oxy/code-map/MAP.md` and MCP tools
of Oxytocin's MCP Hub) to find code with fewer, more targeted searches, and a built-in **Code Map Visualizer** plugin lets
people explore the same graph.

Use **Code Map** as the product name and “Code Map for agents” as descriptive copy.

## Read in this order

1. [Requirements](requirements.md) — business requirements: problem, goals, scenarios, functional and non-functional
   requirements, business rules, metrics, risks, open questions. **Start here.**
2. [Implementation plan](implementation-plan.md) — phases 0–6 with tasks, files, tests, exit criteria and CHANGELOG drafts.
3. [Languages](languages.md) — supported languages, parser assets, extraction and resolution rules (TS/JS, C#, Go, Java,
   Python).
4. [The `.oxy` directory](oxy-directory.md) — folder layout, `.gitignore` handling, `graph.json`, `manifest.json`,
   `MAP.md`, determinism and writing rules.
5. [Design](design.md) — process ownership, graph model, extraction, update algorithm, freshness contract, MCP tools.
6. [Visualizer](visualizer.md) — views, screen layout, graph slice contract, public plugin API, rendering experiment.
7. [Validation](validation.md) — correctness, `.oxy`/determinism, performance, agent evaluation, acceptance checklists.
8. [Research round three](research-round-3.md) — owner brief, what changed against earlier rounds, current Trail-Code,
   new findings in the 0.9.9 baseline.
9. Background: [research round one](research.md) (structural analysis of Trail-Code), [research round two](research-round-2.md)
   (learnings and visualizer research), [learning and context](learning-and-context.md) (specification of the
   self-learning phase 6).

Where documents disagree, the order of authority is: requirements → research round three → implementation plan →
`.oxy` specification → design/visualizer/validation → earlier research.

## Scope at a glance

| Phase | Result                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Parser and packaging spike (Tree-sitter WASM vs TypeScript compiler API), measured in a packaged Windows build.        |
| 1a    | **First release:** enable per project, `.oxy/` + `.gitignore` (on by default, can be turned off), deterministic TS/JS graph, `MAP.md`, background updates, status UI. |
| 1b    | C# (namespaces, `using`, project references, partial types, calls from declared types).                                 |
| 2     | Five read-only MCP tools with freshness metadata, strict checkout selection, worktree maps, instruction block for `CLAUDE.md`/`AGENTS.md`. |
| 3     | Code Map Visualizer plugin on a new public `oxy.codeMap` API (plugin API 0.2.0): Overview, File, Neighborhood, Search.  |
| 4     | Changes overlay, impact view, checkout selector, export; published agent evaluation.                                    |
| 5     | Go, Java, Python (prebuilt grammars, explicit module systems); Rust and PHP on demand. See [languages](languages.md).   |
| 6     | Self-learning context: agent-proposed learnings with evidence in `.oxy/learnings/`, task context, Learnings manager.   |

## Principal decisions

| Decision                                        | Reason                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Map stored in `<checkout root>/.oxy/code-map/`    | Owner decision; one map per checkout (worktrees included); agents can read it as plain files.                    |
| `/.oxy/` in `.gitignore` by default (opt-out)    | Owner decision; with the option off, deterministic map files can be committed, machine-local files stay ignored. |
| JS/TS and C# first, then Go, Java, Python        | Owner priority; prebuilt MIT WASM grammars keep further languages cheap.                                         |
| Learnings in scope (phase 6)                     | Owner decision; the only agent-written part, kept separate from the deterministic map.                           |
| Deterministic, no AI                            | Same files + settings + version → byte-identical `graph.json` and `MAP.md`; no model cost, offline.             |
| Separate Code Map utility host, low priority    | Parsing must never stall terminals, Git or the UI.                                                               |
| Watcher + periodic reconciliation + query check | Editor saves, agent edits, branch switches and missed events all keep the map current.                          |
| `MAP.md` + MCP tools                            | Works for every agent; precise follow-up queries for MCP-connected agents; bounded to avoid context bloat.      |
| Confidence and coverage in every answer         | A syntax-derived graph cannot prove all runtime callers or that a change is safe.                               |
| Visualizer as a built-in plugin                 | Core owns data; the plugin uses a public API; agents work without the plugin.                                   |
| Reimplement, do not vendor Trail-Code           | Oxytocin-specific contracts; MIT attribution kept in the research.                                              |
