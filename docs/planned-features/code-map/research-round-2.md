# Code Map: second-round research

Research date: 2026-10-17. Scope: optional self-learning context for coding agents, machine-readable graphs, and an Oxytocin visualizer plugin. This is source and documentation research, not an implementation, parser benchmark, or independent reproduction of upstream savings.

## Baseline and the change in scope

Inspected local checkouts:

- Oxytocin `6e8ef9d1ce2746767e7e3f24218ec03178f09596`, package version `0.9.7`, initially clean.
- Trail-Code `ead585b2707055f47f1e97d9b0d4209af5285805`, unchanged from round one, initially clean. Its package still says `@nanonets/graft` `0.23.0`.

No upstream installer or agent hooks were run. External sources below were consulted on the research date; they describe upstream capabilities, not dependencies selected or tested for Oxytocin.

Round one answered how to build and query a structural index. It left three gaps: persistent knowledge from completed work, a useful graph projection for an agent's current task, and a concrete visualizer delivery contract. Keeping learnings outside the proposal would omit a central part of the owner's requested feature.

The revised product has two stored layers and several projections:

| Layer / projection | Answers                                                                   | Authority and lifetime                                                            |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Code graph         | Where is this implemented? What statically imports or calls it?           | Derived from saved files; rebuildable; independent per checkout.                  |
| Knowledge layer    | Why is this done? Which failed approach should I avoid? What was learned? | Versioned claims with evidence, origin, applicability, and review state; durable. |
| Task context       | Which code and learnings matter to this question within this budget?      | Bounded projection of both layers at named revisions; short-lived.                |
| Visual graph       | How can a person inspect these relationships and their evidence?          | Presentation of the same service responses; no independent authority.             |

An agent does not need its own duplicate full graph. It needs a correctly scoped view of the graph for its checkout and task. Several agents on the same checkout share indexing work; divergent worktrees do not share structural snapshots.

## What Trail actually contributes

### Learning capture and retrieval

The inspected [notes implementation](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/src/notes/notes.ts) stores agent-authored Markdown summaries with title, author, date, branch, touched files/symbols, and optional discovery cost. Repository notes live in `.trail/learnings`; personal notes live under the user's Trail home. It avoids overwriting an existing note and adds a filename suffix on collision. This is a durable summary mechanism, not model training.

`findNotes` combines title/body query terms with overlap between note touches and retrieved files. Its default limit is two; notes must clear a relevance threshold. [ask-notes.ts](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/src/notes/ask-notes.ts) attaches those notes to code retrieval results. This directly suggests linking knowledge retrieval to code hits instead of injecting every past session.

The [Claude hooks](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/src/claude/hooks.ts) can request a learning after a turn with at least three tool calls and no detected note command. They inspect transcript events and can block stopping once to request the note. This is a client-specific reminder, not evidence that the host can reliably extract useful knowledge from every arbitrary terminal agent.

[Learning-edit checks](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/src/check/learning-edits.ts) preserve the base version of another contributor's learning for conflict checks. The inspected `Note` schema itself does not carry source hashes or the per-checkout applicability lifecycle proposed here. Do not describe that proposal as a Trail feature or infer that Trail has no other conflict checks.

**Adopt:** short findings, file/symbol anchors, targeted retrieval, provenance, and explicit supersession. **Change:** keep durable memory outside the repository by default, validate evidence, isolate worktrees, and offer review/automatic modes. **Do not adopt:** blocking an agent's completion to force a note, automatic repository commits, or estimated discovery cost presented as measured savings.

### Visualization is more than a code graph

[assemble.ts](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/src/viz/assemble.ts) builds a visualization of Markdown context nodes and their frontmatter relationships, reporting malformed nodes and dangling edges. [main.ts](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/viewer/main.ts) offers context, code, and outline views. That context graph is not simply the learning-note collection; avoid conflating these upstream concepts.

[graph.ts](https://github.com/trailhq/Trail-Code/blob/ead585b2707055f47f1e97d9b0d4209af5285805/viewer/graph.ts) uses `d3-force` and persistent SVG elements. Selection distinguishes incoming/outgoing relationships; relation styles convey inferred links; nodes preserve positions by ID. These are useful interaction patterns, but source comments about interactivity are not a measured scale guarantee for an Electron iframe.

**Adopt:** overview plus drill-down, code/context separation, direction, provenance, evidence detail, and stable selection. **Change:** use server-bounded graph slices and package aggregation; do not send the entire symbol graph to a view. Do not copy the viewer, its CSS, or its implementation into Oxytocin.

## External evidence and alternatives

| Primary source                                                                                              | Observed capability / finding                                                                                              | Implication for this proposal                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Aider repository map](https://aider.chat/docs/repomap.html)                                                | Selects repository-map content with graph ranking and a token budget rather than always including every symbol.            | Try bounded structural context; compare ranking with a lexical baseline before adopting it. This does not validate Oxytocin savings.                                                      |
| [Evaluating AGENTS.md, revision 3](https://arxiv.org/abs/2602.11988v3)                                      | In the studied settings, context files did not generally improve success and increased average inference cost by over 20%. | More context can hurt. This studies repository context files, not this proposed dynamic memory system; use it to motivate ablation and end-to-end evaluation, not to predict our results. |
| [Graphiti](https://github.com/getzep/graphiti)                                                              | Models temporal context with provenance and changing facts; its open-source deployment uses a graph database.              | Borrow explicit validity and supersession concepts. A general temporal graph framework is not justified for the initial desktop deployment.                                               |
| [Tree-sitter web binding](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) | Provides a WASM parser binding.                                                                                            | Retain the packaged parser spike; parsing syntax does not establish runtime call relationships.                                                                                           |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)            | Defines discovery, schemas, tool calls, and list-change notifications.                                                     | MCP is a suitable delivery surface. It does not guarantee that a client automatically requests context or submits learnings each turn.                                                    |
| [Cytoscape.js](https://js.cytoscape.org/), [source](https://github.com/cytoscape/cytoscape.js)              | Graph model, visualization, compound nodes, interaction, and layout APIs.                                                  | First candidate for the bounded explorer; test packaging, layout latency, and accessibility support in our view.                                                                          |
| [Sigma.js](https://www.sigmajs.org/)                                                                        | WebGL graph rendering with Graphology integration.                                                                         | Alternative if larger graph views become necessary; compare integration complexity and actual frame times.                                                                                |

These are capability comparisons. No candidate has been installed, benchmarked, or approved as a production dependency by this research. Pin versions and audit all shipped licenses at implementation time.

## Additional Oxytocin integration findings

Paths below were inspected in the round-two baseline. The structural seams from [round one](research.md#existing-oxytocin-seams) still apply.

| Inspected location                                                           | Finding                                                                                                                   | Required change                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/plugin-api/index.d.ts`                                             | Public API exposes projects, UI panels, events, storage, MCP registration, and `ui.openInEditor`; no `codeMap` namespace. | Add a public bounded query API, checkout discovery, status invalidations, and validated source navigation. Reuse view and editor infrastructure.                                                 |
| `src/shared/domain/plugin.ts`                                                | Permissions are an explicit enum; no map or knowledge permission.                                                         | Add `code-map.read` and separate `code-map.knowledge.read`, with descriptions and tests. These are new capabilities, not assumed existing names.                                                 |
| `src/plugin-host/api.ts`, `src/main/services/plugins/plugin-host-service.ts` | API facade and main dispatch both check existing permissions.                                                             | Extend both and validate new inputs/results; enforce current project opt-in on every call.                                                                                                       |
| `packages/plugin-sdk/src/protocol.ts`, `src/plugin-host/views.ts`            | View/backend messages already provide a delivery mechanism.                                                               | Build a plugin-specific validated request protocol, cancellation, and generation-aware responses; no new local HTTP server.                                                                      |
| `docs/plugins/README.md` security section                                    | Views are sandboxed; plugin backends have Node access and are not OS-sandboxed.                                           | Read-only API permissions are an application contract, not protection against an intentionally malicious installed backend. The bundled visualizer must not read private caches directly.        |
| `plugins/usage-monitor/src/host/collectors/`, `store/`                       | Provider-specific collectors and usage persistence already exist.                                                         | Useful references for measured costs and session attribution, not a generic conversation-memory API. Do not import these plugin internals into core or silently repurpose collection for memory. |
| `src/main/services/mcp/caller-context.ts`                                    | Terminal header is explicitly a hint; general project selection has active-project fallback.                              | Retain strict map selection and label generic MCP learning origins honestly; a supplied session ID is not verified identity.                                                                     |
| `src/main/services/mcp/mcp-hub.ts`                                           | Ensemble bridge currently provides project/terminal context, not a dedicated map checkout contract.                       | Bind reads and proposals to authenticated role/task checkout; prohibit automatic worktree-to-main knowledge promotion.                                                                           |

The visualizer should be a bundled plugin under `plugins/code-map-visualizer`, with manifest ID `oxytocin.code-map-visualizer`. It must use the same public API as third-party plugins. The core service continues to index, answer agents, and manage memory when the plugin is disabled.

## Decisions and remaining experiments

| Question                                | Recommendation                                                                                                            | Evidence still needed / fallback                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| How does knowledge arrive?              | Structured proposals from the working agent over MCP, plus user-authored entries.                                         | Verify at least two clients complete a save/reuse cycle; if they do not, add an explicit adapter later, not invisible PTY scraping. |
| Does every finding require review?      | Project mode selects review-before-reuse or automatic admission of eligible, attributed claims.                           | Evaluate false admissions and stale reuse. Automatic mode must remain reversible and visibly unreviewed.                            |
| What does the application build itself? | Code graph, package aggregation, knowledge links, relevance selection, applicability indexes, and bounded task subgraphs. | Semantic architecture synthesis and graph-ranking weights need separate labeled experiments.                                        |
| Where is state stored?                  | Rebuildable immutable code snapshots plus a separate durable, versioned learning store.                                   | Measure JSON rewrite size and crash recovery; SQLite is a possible later storage choice, not a prerequisite.                        |
| What renders the graph?                 | Prototype Cytoscape.js first, compare Sigma.js only if measured constraints warrant it.                                   | Measure in the actual packaged iframe; fall back to bounded lists and smaller slices if rendering fails.                            |
| What is not decided here?               | Exact runtime/grammar versions, renderer version, ranking weights, and production size limits.                            | Record decisions with measured results in the implementation milestones.                                                            |

The scope and recommended delivery order are concrete enough to implement without another product questionnaire. None of the open experiments justify advertising guaranteed savings, perfect call graphs, automatic understanding of every session, or verified truth for model-written claims.
