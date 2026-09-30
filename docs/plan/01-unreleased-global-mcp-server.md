# Plan 01 — One global Oxytocin MCP server with plugin-contributed tools

Status: **planned, not started** · Target: next minor release · Plugin API: **0.1.5**

This document is written for the agent (or person) who implements the feature. Read it completely before starting,
then follow the steps in [Implementation steps](#implementation-steps) in order. Every step ends in a working,
committed state (see the owner's rules in `CLAUDE.md`).

## Goal

Oxytocin exposes **one** local MCP server (`oxytocin`) to AI agents (Claude Code, Codex CLI, Cursor, …). It has a set
of **core tools** of its own, and **plugins contribute further tools** to it. When the user enables, disables,
reloads or installs a plugin, its tools appear or disappear **at runtime**, and connected agents learn about it
without a restart through the MCP `notifications/tools/list_changed` notification.

User-visible result:

- One *Connect Claude Code* action (in core, not in a plugin) registers one server once; it never has to be
  re-registered when plugins change.
- *Settings → Agent tools* lists every tool the agents can use, where it comes from, lets the user turn each one off
  and choose whether it runs without asking, asks first, or is blocked. It shows a log of recent calls.
- Plugin authors add MCP tools with a few lines of manifest and `oxy.mcp.registerTool(...)`.

### Non-goals (for this plan)

- MCP **resources** and **prompts** (MCP prompts would show up as slash commands in Claude Code — a good follow-up,
  keep the design open for `contributes.mcp.prompts`, but do not build it now).
- Remote access (anything other than loopback), OAuth, multiple users.
- Server → client requests (sampling, elicitation). Asking the user goes through Oxytocin's own dialogs instead.
- SSE resumability (`Last-Event-ID` redelivery). A reconnecting client simply lists the tools again.

## Current state (read these files first)

| What | Where |
|---|---|
| The only MCP server today, inside the Project Runner plugin: Streamable HTTP, JSON responses only, **no sessions, no SSE, `listChanged: false`**, Bearer token, Host/Origin checks against DNS rebinding, 1 MB body limit | `plugins/project-runner/src/host/mcp.ts` (+ `mcp.test.ts`) |
| Its tools (`list_run_profiles`, `start_run_profile`, `restart_run_profile`, `stop_run_profile`, `get_run_logs`, `answer_run_prompt`, `add_run_profile`) and the project resolution from `project` / `cwd` arguments | `plugins/project-runner/src/host/tools.ts`, `index.ts` (`resolveProject`, ~line 532) |
| Registration in Claude Code (`claude mcp add --scope user --transport http oxytocin-runner …`), copyable config JSON for other clients, "is connected" check | `plugins/project-runner/src/host/claude.ts` |
| Windows path spellings of an agent's cwd (Git Bash, WSL, 8.3 short names, symlinks) | `plugins/project-runner/src/host/paths.ts` |
| Settings `projectRunner.mcp.enabled`, `projectRunner.mcp.port` (47286), `projectRunner.claudeCommand`; token in plugin storage (`mcpToken`) | `plugins/project-runner/package.json`, `index.ts` |
| Claude Code Bridge uses port 47285 for hooks | `plugins/claude-code-bridge` |
| Two Plugin Hosts: built-in plugins in the main one, user/developer plugins in the external one (ADR-022) | `src/main/services/plugins/plugin-hosts.ts` |
| Main ⇄ Plugin Host RPC contract | `src/shared/rpc/contracts/plugin-host.ts` |
| Plugin manifest schema: permissions, activation events, contributions | `src/shared/domain/plugin.ts` |
| Plugin API as seen by plugins; permission checks in the host | `packages/plugin-api/index.d.ts`, `src/plugin-host/api.ts` |
| Permission checks and API calls in main | `src/main/services/plugins/plugin-host-service.ts` (`permission()`, `apiCall()`) |
| Every terminal gets `OXYTOCIN_TERMINAL_ID` | `src/main/services/terminals/env-composer.ts` (~line 103) |
| Consent dialog model | `src/renderer/src/features/plugins/consent-model.ts` |
| Plugin author docs | `docs/plugins/README.md`, `packages/plugin-api/CHANGELOG.md` |

## Design

### Where the server lives

In **main**, as a new service `src/main/services/mcp/`. Reasons: main already knows the plugin lifecycle
(enable/disable/reload/consent) and supervises both Plugin Hosts; a tool of the external host must be reachable
exactly like one of the built-in host; the core tools need main's services. The server is small async I/O
(`node:http`), which is allowed in main — no synchronous I/O, no heavy work: tool handlers run in the hosts or in
existing services.

```
Claude Code / Codex / Cursor
      │  POST /mcp (JSON-RPC)   GET /mcp (SSE: notifications/tools/list_changed)
      ▼
main: McpHub ─── McpSessions (Mcp-Session-Id → SSE response, lastSeen)
        │
        └── McpToolRegistry: name → { source, definition, policy }
              ├─ core tools (oxy_*)            → main services
              ├─ built-in Plugin Host tools    → RPC 'mcp:callTool'
              └─ external Plugin Host tools    → RPC 'mcp:callTool'
```

Suggested files (adjust to the code you find, keep one concern per file, each with tests):

- `src/main/services/mcp/http-server.ts` — transport: HTTP, auth, Host/Origin, sessions, SSE, JSON-RPC dispatch.
  Start by moving `plugins/project-runner/src/host/mcp.ts` here (keep its tests) and extend it.
- `src/main/services/mcp/tool-registry.ts` — the tool set, diffing, change events, name validation, policies.
- `src/main/services/mcp/core-tools.ts` — the `oxy_*` tools.
- `src/main/services/mcp/caller-context.ts` — who is calling (terminal / project / agent).
- `src/main/services/mcp/client-registration.ts` — `claude mcp add/remove/get`, copyable configs, migration of the
  old `oxytocin-runner` entry. Move `claude.ts` and `paths.ts` logic out of the Project Runner (the runner keeps
  using them through the API or `src/shared` pure helpers — `paths.ts` uses `node:fs`, so it cannot go into
  `src/shared` as is; split the pure part).
- `src/shared/domain/mcp.ts` — zod schemas and types shared by main, hosts and renderer (tool definition, policy,
  call log entry, hub status).

### Protocol (Streamable HTTP, MCP 2025-06-18 with 2025-03-26 / 2024-11-05 fallback)

Keep everything the current server does and add:

1. **Sessions.** The response to `initialize` carries an `Mcp-Session-Id` header (random, 128+ bits,
   `randomBytes(16).toString('base64url')`). Later requests must send it; an unknown or expired id → HTTP **404**
   (the client then initializes again — that is the spec's recovery path). Requests without a session id other than
   `initialize` → 400. Keep sessions in memory only; they die with the app.
2. **Server → client stream.** `GET /mcp` with `Accept: text/event-stream` and a valid session opens an SSE response
   for that session (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, flush
   headers immediately). One stream per session; a new GET replaces the old one. Send a comment heartbeat
   (`: ping\n\n`) every ~20 s so proxies/clients do not time the stream out. Remove the stream on `close`.
3. **`DELETE /mcp`** with the session id ends the session (close its stream) → 200/204.
4. **`capabilities: { tools: { listChanged: true } }`** in `initialize`.
5. **`notifications/tools/list_changed`** is written to every open stream when the *visible* tool set changes
   (names, descriptions, schemas, enabled state). Debounce ~200 ms so a plugin reload (remove + add) sends one
   notification, and skip it when the list after the debounce equals the list before (compare a stable hash).
6. **`notifications/cancelled`** (client → server, `params.requestId`) aborts the matching in-flight call through an
   `AbortSignal`.
7. Accept the `MCP-Protocol-Version` header; reject unknown versions with 400 only if the header is present and
   not one of the supported versions.
8. `tools/call` results: `{ content: [...], isError?, structuredContent? }`. Support `text` and `image`
   (`{ type: 'image', data: base64, mimeType }`) content; cap text at ~256 KB (truncate with a clear note to the
   agent) and images at ~5 MB.
9. Keep: 1 MB request body limit, JSON-RPC batch handling, 202 for notification-only posts, loopback-only `Host`,
   local-only `Origin`, `timingSafeEqual` token comparison, binding to `127.0.0.1` only.

Hand-writing this is ~150 extra lines on top of the existing server and needs no dependency. The alternative is
`@modelcontextprotocol/sdk` (MIT). Only take it if its peer dependencies accept **zod ~4.6** (see *Pitfalls* in
`CLAUDE.md` about checking peer deps) and it does not pull in an HTTP framework; run `npm run licenses:check` and
`npm run licenses:notices` if you add it. Default recommendation: extend the existing server.

### Tool sources and naming

MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$`; Claude Code shows them as `mcp__oxytocin__<name>`.

- Core tools use the reserved prefix `oxy_`.
- A plugin declares one prefix in its manifest (`contributes.mcp.prefix`, `^[a-z][a-z0-9]{1,15}$`, `oxy` reserved).
  All its tool names must start with `<prefix>_`. The registry rejects a tool whose prefix belongs to another
  enabled plugin (built-in plugins win a conflict; the losing plugin gets a visible error in the plugin manager and
  its tools are not listed).
- The Project Runner uses the prefix `run` (`run_list_profiles`, `run_start_profile`, …). Keep the old descriptions,
  they were tuned for agents.

### Manifest (`contributes.mcp`)

Static declarations let Oxytocin list tools **before** the plugin is activated, show them in the consent dialog and
activate the plugin lazily on the first call.

```jsonc
"permissions": ["mcp.tools"],
"activationEvents": ["onMcpTool:tests_run"],
"contributes": {
  "mcp": {
    "prefix": "tests",
    "tools": [
      {
        "name": "tests_run",
        "title": "Run tests",
        "description": "Runs the project's tests and returns the failures with file and line.",
        "inputSchema": { "type": "object", "properties": { "filter": { "type": "string" } } },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false },
        "timeoutMs": 120000
      }
    ]
  }
}
```

- Add `mcp.tools` to `PLUGIN_PERMISSIONS` with the description *"Give AI agents tools to use (through Oxytocin's
  MCP server)"*. The consent dialog lists the tool titles under it.
- Add `onMcpTool:.+` to `ActivationEventSchema`. A call to a declared tool of an inactive plugin activates it with
  this event (and `*`/`onStartup` plugins are already active).
- `inputSchema` must be a JSON Schema object with `type: "object"` (validate the shape with zod; do not try to
  validate arbitrary JSON Schema in the manifest).
- `timeoutMs` default 60 000, max 600 000.

### Plugin API (`oxy.mcp`, API 0.1.5)

```ts
export interface McpApi {
  /**
   * mcp.tools — handles a tool declared in contributes.mcp.tools. Without a handler, calls to the tool fail with
   * "tool not available". Disposing unregisters the handler.
   */
  registerTool(name: string, handler: McpToolHandler): Disposable;
  /**
   * mcp.tools — adds a tool that is not in the manifest (e.g. only while a database is running). The name must use
   * the plugin's prefix. It is listed while the Disposable lives and the plugin is enabled.
   */
  registerTool(definition: McpToolDefinition, handler: McpToolHandler): Disposable;
}
export type McpToolHandler = (
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<McpToolResult | string>;
export interface McpCallContext {
  /** The project the call belongs to (from the caller's terminal, else its cwd argument, else the active project). */
  projectId?: string;
  terminalId?: string;
  agentId?: string;
  /** Aborted when the agent cancels the call, the call times out or the plugin is deactivated. */
  signal: AbortSignal;
}
export interface McpToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
```

- A thrown error becomes `{ isError: true, content: [{ type: 'text', text: message }] }` (same as today).
- Update `packages/plugin-api/index.d.ts`, `packages/plugin-api/CHANGELOG.md` (0.1.5), `docs/plugins/README.md`
  (new section *Tools for AI agents*), and consider a `defineTool(zodSchema, handler)` helper in
  `packages/plugin-sdk` that produces `inputSchema` with zod 4's `z.toJSONSchema`.

### RPC between main and the Plugin Hosts

Extend `src/shared/rpc/contracts/plugin-host.ts` (validate every payload with zod at the boundary, as elsewhere):

- `HostPluginInfo` gets the plugin's MCP tool names (like `commands`, `views`) so the host can reject handlers for
  undeclared names.
- Main → host method `'mcp:callTool': (o: { callId: string; pluginId: string; name: string; args: unknown;
  context: Omit<McpCallContext, 'signal'>; timeoutMs: number }) => McpToolResult`. The host activates the plugin with
  `onMcpTool:<name>` if needed, waits for a registered handler (short grace period, e.g. 5 s, for handlers
  registered during `activate`), runs it with an `AbortController`, and enforces the timeout on its side too.
- Main → host event `'mcp:cancel': { callId: string }`.
- Host → main through the existing `'api:call'`: `mcp.registerDynamicTool` / `mcp.unregisterDynamicTool` (with
  permission check in `plugin-host-service.ts` like other API calls) and `mcp.handlerState` (a handler for a
  declared tool was registered/disposed, so the registry can mark it available).
- On host exit/restart (`UtilityHost`): reject in-flight calls of that host with *"The plugin host restarted; try
  again"*, drop that host's dynamic tools, keep declared tools listed (they activate again on the next call).

### Registry rules

A tool is **listed** in `tools/list` only when all of these hold:

1. Its source is a core tool, or its plugin is enabled, consented (including `mcp.tools`) and not failed.
2. Its name passed validation and has no conflict.
3. The user has not turned it off (`mcp.tools.disabled` setting).
4. Its policy is not `deny`.

The registry emits a change event with the full sorted list; the hub debounces and notifies (see Protocol §5).
Keep the registry pure (no I/O) so it is fully unit-testable.

### Caller context (which terminal/agent is calling)

The best signal is a header with the terminal id. Register the server with
`--header "X-Oxytocin-Terminal: ${OXYTOCIN_TERMINAL_ID}"` **if** the client expands environment variables in headers
of a user-scope HTTP server. **This is unverified — check it on the current Claude Code version before relying on
it.** If it is not expanded, the literal `${OXYTOCIN_TERMINAL_ID}` arrives: treat anything that is not the id of an
existing terminal as absent.

Resolution order in `caller-context.ts`:

1. `X-Oxytocin-Terminal` header naming an existing terminal → its project and agent.
2. A `cwd` or `project` argument (keep the Project Runner's `resolveProject` behaviour, including the Windows
   spellings from `paths.ts`) — core tools that need a project should accept both, as the runner's tools do.
3. The active project; if there is exactly one project, that one.
4. Otherwise a tool error telling the agent to pass `cwd`.

The header is a hint from a local, token-holding client, not a security boundary.

### Core tools (`oxy_*`)

Start small; each must be useful to an agent and safe by default:

| Tool | Default policy | Notes |
|---|---|---|
| `oxy_capabilities` | allow | Lists the current tools grouped by plugin with one-line descriptions. Fallback for clients that ignore `list_changed`. |
| `oxy_list_projects` | allow | Names, roots, git branch. |
| `oxy_list_terminals` | allow | Per project: title, kind, agent, cwd, running/last command and exit code. |
| `oxy_read_terminal_output` | ask | Last N lines (plain text, VT sequences stripped) of another terminal, e.g. a dev server. Reads through the headless mirror; cap N. |
| `oxy_notify_user` | allow | In-app toast plus OS notification when the window is not focused. Rate-limit per session. |
| `oxy_ask_user` | allow | Opens an in-app dialog (question + options or free text) and returns the answer; times out as "no answer". Reuse the dialog host (`src/renderer/src/stores/dialog-store.ts`). |
| `oxy_open_file` | allow | Opens a file preview (the File Preview plugin's opener) at a line. |

Do not add tools that write files or run arbitrary commands to core; agents already can.

### Policies, settings and UI

New core settings (register them in the settings schema with descriptions; they show in *Settings*):

- `mcp.enabled` (boolean, default `true`)
- `mcp.port` (integer, default **47287**; 47285 is the Claude Code Bridge, 47286 the old runner server)
- `mcp.claudeCommand` (string, default `claude`) — replaces `projectRunner.claudeCommand` for registration
- `mcp.tools.disabled` (string array of tool names)
- `mcp.tools.policy` (record name → `allow` | `ask` | `deny`; default from the tool: `ask` when
  `annotations.destructiveHint` is true, else `allow`)

Token: generated once with `randomBytes(24).toString('base64url')`, stored in main's storage (userData, through the
existing JSON store, atomic write), **never logged**, rotated only by an explicit *Reset token* action (which must
re-register the client).

*Settings → Agent tools* panel (renderer, under `src/renderer/src/features/`):

- Server status: port, running/error, connected clients (open sessions), *Connect Claude Code* / *Disconnect*,
  *Copy config for other clients*, *Reset token*.
- Tool list grouped by source (Core, each plugin): title, name, description, on/off switch, policy select.
- Call log: last ~200 calls in memory (time, tool, caller terminal/project, duration, ok/error; **no arguments or
  results by default** — they can contain secrets).

`ask` policy: before running, show an in-app confirmation (tool title, plugin, caller, the arguments as JSON) with
*Allow once*, *Always allow*, *Deny*. If the window is hidden, also send an OS notification. No answer within the
tool's timeout → deny. Never block the hub's event loop while waiting.

### Client registration and migration

- *Connect Claude Code*: `claude mcp remove --scope user oxytocin` then `claude mcp add --scope user --transport
  http oxytocin http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"` (plus the terminal header if
  verified). Reuse the CLI runner from `claude.ts` (PATH extension, Windows `cmd` quoting, 60 s timeout).
- Migration: if `claude mcp get oxytocin-runner` finds the old entry, remove it when connecting the new server, and
  tell the user once. Do this only on an explicit user action, not silently at start-up.
- Copyable JSON for other clients (`mcpServers` format). Codex CLI and Cursor formats differ; verify them before
  offering client-specific snippets.
- The runner's *Connect Claude Code* button and its `projectRunner.mcp.*` settings are replaced by the core ones in
  step 5. Mark the old settings deprecated for one release (ignored, with a note) before deleting them.

### How agents find out about new tools

- Clients that support `list_changed` refresh the list within the running session. Claude Code is believed to
  support it — **verify on the current version first** (step 1 below). Record the result in this file.
- Clients that do not support it see the new tools in their next session (`tools/list` at start).
- `initialize.instructions` is built dynamically: one paragraph on Oxytocin plus one line per plugin that currently
  contributes tools. `oxy_capabilities` is the always-working fallback.
- Descriptions matter: agents choose tools by them, and Claude Code may defer rarely used tools behind its tool
  search. Write descriptions that say *when* to use the tool.

## Pitfalls

- **No feature flags.** Everything on `main` ships with the next release, so every step must leave a complete,
  usable state (no half-built panel, no setting that does nothing). Steps 1–3 add no UI; the *Agent tools* panel
  lands complete in step 4. Aim to ship the whole plan, including the Project Runner migration (step 5), in one
  release so users do not see two MCP servers; until the migration lands, the runner keeps its own server so nothing
  breaks.
- **Do not break the existing runner MCP users.** Their Claude Code config points at `oxytocin-runner` on 47286. The
  migration must be explicit and the old server must keep working until the user reconnects (or for one release).
- **Main process rules:** no synchronous I/O, no blocking waits (the `ask` dialog is async), zod at every boundary
  (HTTP body, RPC payloads, manifest, settings).
- **Security:** bind `127.0.0.1` only; keep the Host and Origin checks (DNS rebinding) and the constant-time token
  check on **every** request including `GET` and `DELETE`; limit sessions (e.g. 32) and SSE streams per session
  (1); cap body and result sizes; never put the token in logs, errors, the call log or crash reports; tool
  arguments are untrusted input — plugins validate them.
- **SSE on Node:** call `res.flushHeaders()`, disable socket timeouts for the stream (`req.socket.setTimeout(0)`),
  and handle `close` to avoid leaking responses. `server.close()` waits for open streams — end them first on stop,
  or the app's quit hangs.
- **Notification storms:** plugin reloads, host restarts and settings edits can change the list many times per
  second; debounce and send only on a real change.
- **Lazy activation races:** a call can arrive while the plugin is activating or its host restarts; wait for the
  handler with a bounded grace period, then fail with a clear message.
- **Two Plugin Hosts:** route by the plugin's host (`runsInBuiltinHost`); never assume the built-in host.
- **Windows (primary platform):** agent cwd spellings (Git Bash `/c/…`, WSL `/mnt/c/…`, 8.3 names, junctions) —
  reuse `paths.ts`; `claude.cmd` needs `shell: true` and `cmd` quoting; localized OS output must not be parsed.
- **Port in use:** report it in the panel and in the status (`EADDRINUSE` → "Port N is in use. Choose another
  `mcp.port`"), do not crash the app.
- **Nested Claude Code env:** `claude` CLI calls from Oxytocin must not inherit `CLAUDECODE` etc. (see *Pitfalls* in
  `CLAUDE.md`); check the CLI runner's env.
- **Import boundaries:** `src/shared` stays pure TS (no `node:http`, no `node:fs`). ESLint enforces it — do not work
  around it.

## Implementation steps

Each step: code + tests, `npm run check` green, relevant E2E green (`xvfb-run -a npm run e2e` on Linux), commit
(Conventional Commits, authored as the owner, no trailers), push.

1. **Hub transport.** `src/main/services/mcp/http-server.ts`: move the runner's server logic, add
   sessions, SSE, `DELETE`, `listChanged: true`, cancellation, size caps. Integration test with a real HTTP client:
   initialize → session id → GET stream → trigger a change → receive `notifications/tools/list_changed` → `tools/list`
   shows the new tool; unknown session → 404; bad token/Host/Origin → 401/403 on POST, GET and DELETE.
   **Manual check:** register the hub in Claude Code by hand (`claude mcp add …`), start a session, add a test tool,
   and confirm Claude Code picks it up without restarting. Also check whether `${OXYTOCIN_TERMINAL_ID}` is expanded in
   the header. Write both results into this file (*Verification log* below).
2. **Registry + core tools.** Pure registry with unit tests (listing rules, prefix conflicts, debounce/diff, policy
   defaults). Core tools with unit tests. Settings `mcp.*`, token storage, caller context.
3. **Plugin contributions.** Manifest schema (`contributes.mcp`, `mcp.tools` permission, `onMcpTool:` activation),
   RPC methods, `oxy.mcp.registerTool` in `src/plugin-host/api.ts`, host restart handling, Plugin API 0.1.5 types and
   changelog, `docs/plugins/README.md`. Tests: schema unit tests, host API unit tests, an integration test with a
   fixture plugin in `tests/fixtures/plugins/` (enable → tool listed → call → disable → removed → notification sent).
4. **Agent tools panel + client registration.** Settings panel, *Connect Claude Code*, copy config, reset token,
   `ask` dialog, call log. E2E test (`tests/e2e/mcp-hub.spec.ts`): enable a fixture plugin in the plugin manager → an
   SSE client connected to the hub receives `list_changed` and sees the tool; turning the tool off in the panel
   removes it; an `ask` tool shows the dialog and *Deny* returns an error to the client.
5. **Migrate the Project Runner.** Its tools move to `contributes.mcp` with prefix `run` and are handled through
   `oxy.mcp`; its own server, token, `projectRunner.mcp.*` settings and connect button go away (settings deprecated
   for one release); the Run view links to *Settings → Agent tools* for connecting. Update its README and
   `tests/e2e/project-runner.spec.ts`. Migration of the `oxytocin-runner` registration.
6. **Wrap up.** Update the README's feature list. After the release that contains the feature, rename this file from
   `01-unreleased-…` to `01-released-…` (or delete it).

Steps that change what users see (4 and 5, and any user-visible part of the others) add their entry to
`## [Unreleased]` in `CHANGELOG.md` in the same commit (user-facing wording: one MCP server, plugin tools appear
live, *Agent tools* settings, runner migration note).

## Definition of done

- One `oxytocin` MCP server; core tools work in Claude Code.
- Enabling/disabling/reloading a plugin with MCP tools changes the tool list of a **running** Claude Code session
  (or, if that turns out to be unsupported, the limitation is documented in the panel and in this file).
- Tools can be turned off and set to allow/ask/deny; `ask` works with the window hidden.
- The Project Runner's tools work through the hub; existing users get a clear one-time migration.
- Host crash/restart, port in use and a stopped server are handled without hangs (including app quit with open SSE
  streams).
- Unit, integration and E2E tests as listed; `npm run check` green; docs and changelogs updated.

## Verification log

Fill in during step 1.

- Claude Code version tested: _
- `notifications/tools/list_changed` refreshes tools in a running session: _
- `${OXYTOCIN_TERMINAL_ID}` expanded in `--header` of a user-scope HTTP server: _
