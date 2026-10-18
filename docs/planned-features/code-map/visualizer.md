# Code Map Visualizer

Proposed phases 3–4 of the [implementation plan](implementation-plan.md) (requirements FR-VIS in [requirements](requirements.md#56-visualizer-fr-vis)): a bundled, independently disableable plugin in `plugins/code-map-visualizer`, manifest ID `oxytocin.code-map-visualizer`, display name **Code Map Visualizer**. Its purpose is to explain and navigate relationships that the core already exposes to agents. It owns neither indexing nor durable memory.

## Useful views of the same graph

| View         | Default content                                                                                      | User action / value                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Overview     | Bounded package/directory groups with aggregated import dependencies and coverage counts.            | Find a subsystem and drill into its files. (Phase 3)                                                 |
| File         | A file's outline (symbols), its imports and its importers.                                           | Understand one file's role before reading it. (Phase 3)                                              |
| Neighborhood | Selected file/symbol, incoming/outgoing neighbors, depth one by default.                             | Trace a dependency or inspect a likely impact area with evidence. (Phase 3)                          |
| Changes      | Uncommitted (or worktree) changes highlighted, with potential dependents in indexed code shaded.     | Review what an agent's change touches and what could depend on it. (Phase 4, needs `git.read`)       |
| Impact       | Incoming relations of a node to depth 3, grouped by folder.                                          | Estimate the reach of a change; worded as “potential dependents in indexed code”. (Phase 4)          |
| Knowledge    | Applicable learning nodes connected to source/evidence anchors, with optional stale/pending filters. | See why a constraint exists, inspect origin, open the core Learnings manager. Only with phase 6.     |
| Task context | A selected query's bounded projection when a live receipt is explicitly opened by the user.          | Inspect what the context tool returned and why it selected those items. Only with phase 6.           |

Directory/package grouping is a deterministic projection, not an inferred architecture. Label a manually named subsystem as user-authored; automatic architectural summaries belong to a later evaluated extension. Phase 3 requires Overview, File, Neighborhood and Search; phase 4 adds Changes and Impact. Knowledge/Task context appear only when phase-6 capabilities exist, not as broken controls before.

Every panel shows the selected project **and checkout**, generation/checkpoint, coverage, known pending changes, and truncation. A graph with no incoming edges does not prove a symbol is unused. For impact views, say **Potential dependents in indexed code**; do not call the result a complete blast radius.

## Core graph projection contract

The core produces graph data without a visualizer installed. Add a shared bounded projection operation, consumed by the plugin and reused in agent context assembly:

```ts
type GraphSliceRequest = {
  projectId: string;
  checkoutId: string;
  view: 'overview' | 'file' | 'neighborhood' | 'impact' | 'knowledge'; // 'knowledge' only with phase 6
  root?: { path: string } | { symbolId: string } | { learningId: string };
  generation?: string;
  relations?: string[]; // validated enum per graph layer in the actual schema
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: 1 | 2 | 3;
  pathPrefix?: string;
  includeHeuristic?: boolean;
  maxNodes?: number;
  maxEdges?: number;
  freshness?: 'latest' | 'allow-stale' | 'verified';
};
```

Return typed nodes/edges, source locators, provenance/review/applicability, group counts, generation and optional memory revision, coverage, and truncation/omission reasons. An aggregate edge reports its relation, count, and underlying coverage; expanding it runs a bounded query. Separate `contains`/group membership from call/import dependencies to avoid dense stars dominating the view. Never synthesize a resolved target for an unresolved relation.

Initial visual limits: default 150 nodes / 300 edges, hard 500 / 1,000, and 512 KiB serialized payload including metadata. Traversal still has the core visited-node/edge caps. Stop on the first reached bound and disclose truncation. MCP results retain their much smaller character budget; a plugin limit is not permission to enlarge agent payloads. Use explicit expand/filter requests, not unlimited pagination that reconstructs the full graph in the browser.

The first protocol returns a full bounded slice and compact invalidation events, not an incremental streaming graph protocol. Expansions tied to an unavailable generation return `SNAPSHOT_CHANGED`. Requery and reconcile selection by stable identity; never merge two generations into a graph that looks coherent. Retain at most the current view and bounded navigation history in the plugin.

## Public plugin API changes

Add a versioned `oxy.codeMap` namespace to the public backend API (plugin API `0.2.0`). These proposed methods do not exist in the current `0.1.9` API:

| Method / event                      | Contract                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listCheckouts(projectId)`          | Returns registered checkout IDs/labels and supported capabilities; never scans arbitrary roots.                                                             |
| `status({ projectId, checkoutId })` | Compact state, coverage, generation, freshness, memory availability; no knowledge content.                                                                  |
| `query(request, { signal })`        | Search/outline/relations/graph-slice/context-receipt discriminated request; validated bounded result and cancellation.                                      |
| `onDidChange(listener)`             | Project/checkout, state, new generation/memory revision; invalidation only, no source bodies.                                                               |
| `openSource(locator)`               | Resolve a current, authorized map locator and delegate to the existing editor navigation service. Reject excluded/escaped paths and stale mismatched spans. |

Add `code-map.read` for structural queries (phase 3); `code-map.knowledge.read` for memory contents is added only with phase 6, and mixed slices then require both. The visualizer also needs existing `projects.read`, and `git.read` for the phase-4 Changes view. These permissions apply to API access and must be checked in both the facade and main dispatch, with project opt-in and disposal/revocation checked on every operation. They do not OS-sandbox a Node plugin backend.

The plugin obtains checkout IDs from the public API; it cannot invent a worktree path, enable indexing by querying, or fall back to the active project when a selected checkout disappears. On disabled maps, show a core settings link. Add documented core commands for opening Code Map settings, the Learnings manager, and a live task-context receipt, with validated project/checkout/learning/receipt IDs; extend the existing command allowlist rather than using private renderer IPC. Receipt queries obey the historical-availability and revocation contract in [learning and context](learning-and-context.md#agent-tools-and-task-context-assembly); an expired receipt displays an explicit unavailable state.

Do not request `mcp.tools`, terminal read/write permissions, or file-read permissions for the bundled visualizer. Core owns agent tools and source reads. Do not route through the MCP HTTP endpoint or expose its bearer token to the iframe. UI preferences such as filters, zoom, and pinned positions belong in plugin storage; code/knowledge remains in core stores. Disabling/uninstalling the plugin must not delete them.

Integration work touches `packages/plugin-api/index.d.ts` and changelog, `src/shared/domain/plugin.ts`, new shared schemas, `src/plugin-host/api.ts`, `src/main/services/plugins/plugin-host-service.ts`, and event delivery/host contracts. Verify actual source locations before implementation. Use `@oxytocin/plugin-sdk` view requests, validate every message, and publish capability/version handling for older engines.

## Screen layout

```text
┌ Code Map — Oxytocin · main checkout · Ready (generation 42, 2 s ago) · 2,064 files ───────────────┐
│ [Search files and symbols…]  View: (Overview|File|Neighborhood|Changes)  Relations ▾  Depth 1 ▾   │
├───────────────────────────────────────────────────────────────┬──────────────────────────────────┤
│                                                               │ src/main/hosts/hosts.ts           │
│   ┌ src/main ───────┐        ┌ src/shared ──────┐             │ file · TypeScript · 160 lines     │
│   │ hosts  services │ ─128─▶ │ rpc  domain ipc  │             │ Imports 9 · Imported by 14        │
│   └─────────────────┘        └──────────────────┘             │ Exports: Hosts, SupervisedHost    │
│            │ 42                       ▲ 77                    │ [Open in editor] [Neighborhood]   │
│            ▼                          │                       │ Evidence: import at line 3 …      │
│   ┌ src/code-map-host ┐      ┌ src/renderer ┐                 │                                   │
│   └───────────────────┘      └──────────────┘                 │                                   │
├───────────────────────────────────────────────────────────────┴──────────────────────────────────┤
│ Showing 38 of 412 nodes (limit) · 3 unresolved imports · [List view] [Fit] [Back]                  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The header always names project, checkout, state and generation; the footer states truncation and coverage. The list
view replaces the canvas with an accessible table of the same slice (node, kind, relation, direction, evidence).

## Interaction and lifecycle

Use a search box and filters above the canvas, a node/evidence detail panel, and an equivalent keyboard-accessible relation list. Selecting a node highlights direction and relationship labels; double-click or an explicit action opens source. Distinguish edge kinds using line styles/labels as well as color. Automatically admitted knowledge must look different from reviewed knowledge and structural facts; stale records are hidden by default outside inspection mode.

Pan, zoom, fit, back, and one-hop expansion are sufficient initially. Keep positions for surviving IDs when refreshing; do not continuously animate the entire graph while files are saved. Stop layout when hidden/disposed, cancel obsolete requests, and debounce invalidations. A rapid project switch must clear the previous project's graph immediately and discard late replies using a request sequence plus checkout identity.

Never send graph updates through React state on every layout tick. Use the renderer's imperative graph API for canvas updates, and React for controls/detail state if chosen. Follow SDK theme tokens, iframe lifecycle, and the app's existing drag behavior. Bundle all scripts/fonts/layout assets locally and test the iframe CSP; no CDN or viewer server.

When a source anchor changes, offer to reopen current source without relying on an obsolete span. The core resolves locators and converts its 0-based UTF-16 columns to the editor adapter's documented convention; test the conversion rather than assume public `openInEditor` uses parser coordinates.

## Rendering decision and experiment

Prototype [Cytoscape.js](https://js.cytoscape.org/) first: compound nodes and graph interaction fit the explorer's bounded group/neighborhood views. Evaluate its built-in layouts before adding a layout dependency. [Sigma.js](https://www.sigmajs.org/) is an alternative for WebGL rendering if measured graph size makes that worthwhile. Trail's D3/SVG implementation is another reference for interaction, but building all navigation/layout behavior ourselves adds work.

This is a recommendation, not a measured library selection. Run 50/150/500-node fixtures with corresponding edge caps in the packaged plugin iframe, including cycles, high-degree hubs, long labels, and rapid invalidation. Record first usable layout, input latency, frame rate, memory, and terminal latency. Initial targets: default-view layout under one second, interaction p95 under 100 ms, and no more than 10% terminal p95 regression against the same workload without the view. Stop/reduce expensive layouts rather than blocking the app; retain the list alternative if graphics initialization fails.

The spike must also verify hidden-panel suspension, WebGL availability if used, keyboard/list navigation, contrast, source opening, packaged offline assets, and engine compatibility. Audit exact dependency and extension licenses before adoption. No library demo or theoretical node count substitutes for this application-level check.
