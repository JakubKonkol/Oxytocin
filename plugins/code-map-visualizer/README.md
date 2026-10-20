# Code Map Visualizer

Open **Code Map** from a project's menu, Code Map settings, the Add menu, or **Code Map: Open**. Enable indexing in
project settings first. The plugin uses public APIs with `projects.read`, `code-map.read` and `git.read`.

Overview groups folders and aggregates indexed dependencies. Select a folder to explore it, a file for declarations,
or search for a symbol and explore its neighborhood. Filter directions, relation types, evidence and depth (1–3).
The graph supports dragging, pan, zoom and fit; surviving node positions persist across refreshes. There is no
continuous layout animation. Hidden panels cancel reads and stop graph updates.

Select **List only** for keyboard navigation. Tab to a node and press Enter, then choose **Explore one step** or
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

Assets and Cytoscape.js (MIT) ship with the plugin; it needs no CDN, network connection or compiler. Disable the plugin
to remove visualization; indexing and agent MCP tools remain core features. No API credentials or MCP server token
are supplied to the iframe.
