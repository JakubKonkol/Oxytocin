# Stage 08: bounded plugin access

Implemented public Plugin API 0.2.0 with the `code-map.read` permission. Both the plugin facade and main dispatch
validate access and data. A reader's cancellation does not stop indexing. Plugin disable, permission revocation and
host restart cancel its pending requests. Project/checkout ownership is checked before and after host calls.

Slices use defaults of 150 nodes / 300 edges, hard caps of 500 / 1,000, and a 512 KiB UTF-8 envelope cap. Overview
groups aggregate underlying imports/references from one immutable generation. File and neighborhood views reuse the
bounded relations index. Membership and dependency edges remain distinct. Stale expansions return SNAPSHOT_CHANGED.

Source navigation revalidates generation, indexed membership, normalized content hash, symbol and UTF-16 range in
the host, then delegates to the configured editor. Worktree identity travels into the built-in editor and its file
service; identical relative paths in different checkouts cannot reuse each other's editor panel.

Behavior tests cover deterministic aggregation, cycles, caps and multi-byte payloads, API validation and permissions,
targeted invalidations, aborts, editor column conversion and worktree identity. A real parser/indexer + fixture plugin
integration test compares plugin/agent relations, follows edits and rejects stale source locators and disabled maps.
An Electron E2E case is included but unexecuted: Docker is unavailable and WSL has no distribution. The user explicitly
authorized available checks and recording this exception. No paid models were called.

Full `npm run check` and `npm run build` passed. Validation logs:
`test-results/code-map-stage08-check.log`, `test-results/code-map-stage08-build.log`.
Existing performance, installer, manual-client and dogfooding release gates remain open.
