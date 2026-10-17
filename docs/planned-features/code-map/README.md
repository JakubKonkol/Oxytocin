# Code Map

Status: proposal; no runtime implementation. Research date: 2026-10-17.

Build an optional, local map of a project's files, symbols, imports, and resolvable calls. Keep it synchronized with saved code and expose concise context to agents through Oxytocin's existing MCP Hub. The intended benefit is less repeated exploration, with fewer tokens and tool calls; that benefit must be measured, not assumed.

Recommended product name: **Code Map**. Use **Code Map for agents** as descriptive copy. “Agents Code Mapping” is longer and describes an operation rather than the thing the user enables.

## Read in this order

1. [Research](research.md): how Trail-Code works, evidence, limitations, and existing Oxytocin integration points.
2. [Design](design.md): product behavior, process boundaries, indexing, freshness, and agent contracts.
3. [Implementation plan](implementation-plan.md): ordered work packages and acceptance criteria.
4. [Validation](validation.md): correctness, packaging, performance, and agent outcome evaluation.

## Recommended scope

- Enable separately in **Project settings → Code Map**, initially off for existing and new projects. This is a persistent user preference controlling CPU, storage, and agent access, not a rollout or experimental feature flag. It implements the owner's explicit request for an optional feature.
- First release: TypeScript, TSX, JavaScript, and JSX; file and symbol search, file outlines, bounded dependency traversal, automatic updates, status/rebuild controls, and MCP discovery. Other languages appear in coverage counts as unsupported.
- Use a supervised Code Map utility host, locally packaged Tree-sitter WASM grammars, an application-owned cache outside the repository, and the current MCP server.
- Start with deterministic extraction and lexical retrieval. No API key, embeddings, generated summaries, hosted service, or recurring model cost for indexing.
- Deliver a complete first vertical slice. Additional languages and a visual graph explorer follow as independently usable extensions.
- Reimplement the concept with Oxytocin-specific contracts. Do not vendor Trail-Code, run its installer, or copy its implementation, query files, or instruction templates.

The feature indexes saved files while Oxytocin runs. Unsaved editor buffers are outside the first release. Closing the app stops synchronization and MCP service; reopening reconciles the cache before answering. A continuously running background service outside Oxytocin is outside this proposal.

## Principal decisions

| Decision                                  | Reason                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MCP first                                 | Oxytocin already has authentication, tool policies, discovery, client setup, cancellation, and call logs.      |
| Watcher plus query freshness checks       | Editor changes, agent changes, branch switches, and missed events all matter.                                  |
| Separate analysis host                    | Parsing and graph resolution must not stall terminal handling, Git operations, or the main process.            |
| Confidence and coverage in results        | A syntax-derived graph cannot prove all runtime callers or that a change is safe.                              |
| Independent cache per canonical checkout  | Ensemble worktrees may contain different code even when they belong to one project.                            |
| No automatic repository instruction edits | A short MCP brief and a copyable rule are sufficient initially; user-authored rules remain under user control. |

Open engineering gates are WASM packaging/performance, acceptable TS/JS resolution coverage, and measured agent benefit. They have explicit experiments in the implementation and validation documents. They do not require another product decision before work can begin.
