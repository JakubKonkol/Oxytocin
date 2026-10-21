# Code Map Visualizer

Open **Code Map** from a project's menu, Code Map settings, the Add menu, or **Code Map: Open**. Enable indexing in
project settings first. The plugin uses public APIs with `projects.read`, `code-map.read`, `code-map.knowledge.read`
and `git.read`.

Overview groups folders and aggregates indexed dependencies. Select a folder to explore it, a file for declarations,
or search for a symbol and explore its neighborhood. Filter directions, relation types, evidence and depth (1–3).
The graph uses a force layout that accounts for labels. Select a node to highlight its neighbors and show directional
connections in the inspector. Edge labels appear only in that neighborhood. The graph supports dragging, pan, zoom
and fit; surviving positions persist across refreshes and switching to Outline. There is no
continuous layout animation. Hidden panels cancel reads and stop graph updates.

Use **Code** for the structural graph, **Context** for findings, and **Outline** for keyboard navigation. Advanced
views and relation filters are under **Views & filters**, with coverage diagnostics in the footer. Tab to a node in
Outline and press Enter, then choose **Explore one step** or
**Open in editor** in the details. Graph labels and line styles distinguish relation types and heuristic evidence.
The footer reports generation, coverage, omissions and truncation. Missing edges do not establish that code is unused.
Source opening verifies the generation/hash/range and uses the user's configured editor.

Choose **Changes** to highlight Git changes (diamonds and explicit Changed labels) and potential dependents
(rectangles and text labels), grouped by folder. The main checkout shows uncommitted changes; Ensemble worktrees
compare with the task's recorded base, including committed changes. The checkout selector preserves source navigation
identity and refuses a removed checkout. Refresh to discover newly registered worktrees.

Select a file or symbol and choose **Show potential dependents**, or **Impact**, for incoming dependencies to depth
1–3. Heuristic edges are excluded unless requested. File impact projects cross-file symbol relations to their owning
files without charging membership as a hop. Deleted, renamed-away or excluded files can be absent from the current
index; their Git entries remain visible, and the footer recommends source search and diff review. Missing edges do
not prove code is unused. Git and index snapshots are separate checkpoints, so refresh after ongoing edits.

Both Git change paths and graph results are bounded; truncation is visible. Export is deferred; this version focuses
on inspecting and navigating the current view.

**Knowledge** shows applicable reviewed findings and their recorded evidence by default. Inspect pending proposals,
findings needing review, or all records with the filter. Reviewed findings are rounded rectangles, proposals diamonds,
findings needing review triangles, and imported automatic records gray hexagons. Evidence nodes are rectangles;
knowledge edges are dashed and never participate in structural impact queries. Automatic records are quarantined from
Review retrieval. Matching evidence hashes establish freshness, not semantic truth. **Open Learnings manager** opens
the core review UI with `oxytocin.codeMap.openLearnings(projectId)`.

**Task context** accepts the receipt returned by `oxy_task_context`. Use the form or the documented core command
`oxytocin.codeMap.openReceipt({ projectId, checkoutId, receipt })`. It shows selected IDs, evidence and inclusion reasons,
without retaining the question. Receipts expire after 30 minutes, host restart or revocation. Changed code generations
or memory revisions show an explicit unavailable state; request new context. Off mode preserves stored findings but
hides them here. Removed checkouts are never replaced with the main checkout. Reference findings remain untrusted data.

Assets and Cytoscape.js (MIT) ship with the plugin; it needs no CDN, network connection or compiler. Disable the plugin
to remove visualization; indexing and agent MCP tools remain core features. No API credentials or MCP server token
are supplied to the iframe.
