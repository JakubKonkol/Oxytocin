# Code Map

Status: second-round proposal; no runtime implementation. Research updated: 2026-10-17.

Build an optional, local **self-learning context layer for coding agents**: a continuously updated code graph, durable project learnings linked to evidence, and bounded task context delivered through Oxytocin's existing MCP Hub. Offer a separate `code-map-visualizer` plugin for exploring the same data. The intended benefit is less repeated exploration and fewer repeated mistakes; measure correctness, tokens, tool calls, and total cost rather than assuming that more context helps.

Here, self-learning means retaining and reusing useful findings across sessions, checking their applicability as code changes, and accepting corrections. It does not mean training model weights. Deterministic indexing alone is the foundation, not the completed self-learning feature.

Recommended product name: **Code Map**. Use **Code Map for agents** as descriptive copy. “Agents Code Mapping” is longer and describes an operation rather than the thing the user enables.

## Read in this order

1. [Research](research.md): first-round structural analysis, with corrections for the expanded scope.
2. [Second-round research](research-round-2.md): Trail learnings and visualizer, external evidence, integration gaps, decisions, and open experiments.
3. [Design](design.md): core service, graph model, indexing, freshness, and structural agent contracts.
4. [Learning and context](learning-and-context.md): capture/reuse loop, evidence, invalidation, persistence, and agent APIs.
5. [Visualizer](visualizer.md): plugin boundary, graph projections, public API, UX, and rendering choices.
6. [Implementation plan](implementation-plan.md): independently usable milestones and acceptance criteria.
7. [Validation](validation.md): correctness, packaging, performance, longitudinal learning, and agent outcome evaluation.

The second round preserves the structural architecture and replaces the earlier exclusion of learnings. Memory and visualization now have explicit delivery milestones in this proposal. All API names and defaults below are proposed, not shipped.

## Recommended scope

- Enable separately in **Project settings → Code Map**, initially off for existing and new projects. This is a persistent user preference controlling CPU, storage, and agent access, not a rollout or experimental feature flag. It implements the owner's explicit request for an optional feature.
- First release: TypeScript, TSX, JavaScript, and JSX; file and symbol search, file outlines, bounded dependency traversal, automatic updates, status/rebuild controls, and MCP discovery. Other languages appear in coverage counts as unsupported.
- Use a supervised Code Map utility host, locally packaged Tree-sitter WASM grammars, an application-owned cache outside the repository, and the current MCP server.
- Start with deterministic extraction and lexical retrieval. No API key, embeddings, generated summaries, hosted service, or recurring model cost for indexing.
- Deliver three usable milestones: **A — structural map**, **B — self-learning context**, **C — visualizer plugin**. A can ship first but must not be presented as the finished self-learning layer. B is part of the requested scope; C uses the shared service and can ship independently of B's learning UI.
- Memory has its own project setting: off, review before reuse, or automatic reuse of eligible agent proposals. Keep source-derived facts, agent claims, and user-reviewed knowledge visibly distinct. No passive transcript collection or background model calls in A–C.
- Generate graphs in the core, including package/file aggregation and bounded task neighborhoods. Agents consume structured subgraphs and evidence, not screenshots or a full-repository dump.
- Reimplement the concept with Oxytocin-specific contracts. Do not vendor Trail-Code, run its installer, or copy its implementation, query files, or instruction templates.

The feature indexes saved files while Oxytocin runs. Unsaved editor buffers are outside the first release. Closing the app stops synchronization and MCP service; reopening reconciles the cache before answering. A continuously running background service outside Oxytocin is outside this proposal.

## Principal decisions

| Decision                                   | Reason                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| MCP first                                  | Oxytocin already has authentication, tool policies, discovery, client setup, cancellation, and call logs.      |
| Watcher plus query freshness checks        | Editor changes, agent changes, branch switches, and missed events all matter.                                  |
| Separate analysis host                     | Parsing and graph resolution must not stall terminal handling, Git operations, or the main process.            |
| Confidence and coverage in results         | A syntax-derived graph cannot prove all runtime callers or that a change is safe.                              |
| Independent cache per canonical checkout   | Ensemble worktrees may contain different code even when they belong to one project.                            |
| No automatic repository instruction edits  | A short MCP brief and a copyable rule are sufficient initially; user-authored rules remain under user control. |
| Separate graph cache and durable learnings | Rebuilding a derived index must never delete knowledge captured from work.                                     |
| Evidence and applicability before reuse    | A frequently retrieved claim is not necessarily true; changed evidence must invalidate applicability.          |
| Core owns data; plugin owns visualization  | Agents work without an open panel or installed visualizer; there is only one index and freshness contract.     |

Open engineering gates are packaged WASM performance, TS/JS resolution coverage, reliable learning admission/invalidation, measured agent benefit, and bounded graph rendering in the plugin iframe. The implementation plan assigns each gate an experiment and an exit condition. Cloud sharing, arbitrary transcript mining, and autonomous model-based synthesis remain outside A–C.
