# Code Map Visualizer

Open **Code Map** from a project's menu, Code Map settings, the Add menu, or **Code Map: Open**. Enable indexing in
project settings first. The plugin uses the public `oxy.codeMap` API with `projects.read` and `code-map.read`.

Overview groups folders and aggregates indexed dependencies. Select a folder to explore it, a file for declarations,
or search for a symbol and explore its neighborhood. Filter directions, relation types, evidence and depth (1–3).
The graph supports dragging, pan, zoom and fit; surviving node positions persist across refreshes. There is no
continuous layout animation. Hidden panels cancel reads and stop graph updates.

Select **List only** for keyboard navigation. Tab to a node and press Enter, then choose **Explore one step** or
**Open in editor** in the details. Graph labels and line styles distinguish relation types and heuristic evidence.
The footer reports generation, coverage, omissions and truncation. Missing edges do not establish that code is unused.
Source opening verifies the generation/hash/range and uses the user's configured editor.

Assets and Cytoscape.js (MIT) ship with the plugin; it needs no CDN, network connection or compiler. Disable the plugin
to remove visualization; indexing and agent MCP tools remain core features. No API credentials or MCP server token
are supplied to the iframe.
