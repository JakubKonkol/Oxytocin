# Changelog

## 0.2.1

- `knowledge` and `context-receipt` slices require **both** `code-map.read` and `code-map.knowledge.read`. Structural
  queries and their events expose no knowledge labels, records or counts. Revocation cancels pending knowledge reads.
- `oxy.codeMap.onDidChangeKnowledge` (`code-map.knowledge.read`) emits a targeted project/checkout/revision hint.
  Learning/evidence nodes and logical `applies_to`, `supported_by`, `supersedes`, `conflicts_with` edges are reference
  data, separate from structural dependencies. Knowledge filters: `active` (default), `pending`, `stale`, `all`.
- `context-receipt` accepts the opaque receipt returned by `oxy_task_context`, reconstructing only selected IDs,
  revisions and inclusion reasons while its code/memory checkpoint remains available. Receipts expire after 30 minutes
  or revocation; no original question is retained. `SNAPSHOT_CHANGED` and `RECEIPT_EXPIRED` carry no replacement data.
- Core commands: `oxytocin.codeMap.openLearnings(projectId)` opens the core manager;
  `oxytocin.codeMap.openReceipt({ projectId, checkoutId, receipt })` opens the built-in visualizer's Task context view.
  Call them with `oxy.commands.execute` or a view's `executeCommand`. The visualizer must be enabled for receipt display.

## 0.2.0

- Impact slices accept a symbol/file root or up to 500 changed paths and return bounded incoming dependencies.
  `oxy.git.getCheckoutChanges(ref)` requires `git.read` and `code-map.read`; worktrees compare with their stored task
  base. Git paths are checkout-relative; changes and impact remain explicitly non-exhaustive.
- `oxy.codeMap` (`code-map.read`): list registered checkouts, read status, query search/outline/relations and bounded
  graph slices, subscribe to compact invalidations, and open verified source locations. Query cancellation uses
  `AbortSignal`; stale slice expansions return `SNAPSHOT_CHANGED`. Source spans use one-based lines and zero-based
  UTF-16 columns. Projects must explicitly enable Code Map; queries cannot enable indexing.
- Update plugin manifests to `engine: "^0.2.0"` after checking compatibility. A caret range of 0.x versions does not
  include the next minor version, so plugins declaring `^0.1.x` are reported as incompatible and do not load.

## 0.1.10

- `oxy.agents.launch({ claudeArgs, env })`: arguments added to a new Claude Code session's launch command (quoted for
  the terminal's shell) and environment variables of a new session's terminal. Reused sessions keep theirs.
- `AgentLauncher.agent`: the CLI a launch choice starts (`claude`, `codex`, `gemini`…).

## 0.1.9

- `oxy.ui.openPanel(…, { placement: 'sidebar' })` opens a right-sidebar tool without requiring a project. It follows
  the active project with no `view.projectId`. A matching singleton in either sidebar or the active workspace is
  revealed instead of opening another panel.
- `oxy.agents.launch` reveals and focuses the terminal in its project's workspace, including reused sessions.

## 0.1.8

- `oxy.agents.listLaunchers()` (`agents.read`): the same visible agents, added accounts and API profiles as the
  workspace's + menu, without credentials.
- `oxy.agents.launch(options)` (`agents.read`, `terminals.create`, `terminals.write`): reuses a matching terminal or
  opens an ordinary terminal with the configured launch command. Optionally selects an existing session, opens a
  fresh session, starts a new Claude session in plan mode, and delivers a prompt only when the agent is ready.
  Returns the terminal id and delivery result; blocked delivery can be retried explicitly.
- `oxy.agents.sendPrompt` accepts up to 200,000 characters to support approved plan documents.

## 0.1.7

- Agent accounts: `oxy.agents.listAccounts()` and `onDidChangeAccounts` (`agents.read`) — the main account of Claude
  Code, Codex CLI and Gemini CLI and the accounts added in Settings → AI Agents; `AgentSnapshot.accountId` says which
  one an agent runs on.
- Plan limits: `oxy.agents.getLimits()` and `onDidChangeLimits` (`agents.read`), `oxy.agents.reportLimits(limits)`
  (`agents.annotate`) — e.g. Claude Code's 5-hour and weekly windows per account, as the Usage Monitor reads them.
- `oxy.agents.sendPrompt(terminalId, text)` (`terminals.write`): types a prompt into an idle agent and submits it,
  never over a question on screen; resolves once the agent started working, or with the reason it was not sent.

## 0.1.6

- `oxy.ui.showNotification({ …, signal })`: an `AbortSignal` withdraws a notification with `actions` (the question
  was answered elsewhere or no longer applies); it closes and the promise resolves `undefined`.

## 0.1.5

- Tools for AI agents: `contributes.mcp` (`prefix`, `tools`), the `mcp.tools` permission, the `onMcpTool:<name>`
  activation event and `oxy.mcp.registerTool(name | definition, handler)`. The tools are offered by Oxytocin's MCP
  server (`oxytocin`); agents see them without restarting when a plugin is enabled, disabled or reloaded.

## 0.1.4

- `oxy.terminals.create({ …, env, reveal })`: per-terminal environment variables, and `reveal: false` to start a
  terminal in the background without a panel.
- `oxy.terminals.show(id, { preserveFocus?, placement? })` (`terminals.read-metadata`): reveals a terminal, opening a
  panel for a background one.
- `oxy.terminals.kill(id, { force? })` and `oxy.terminals.close(id)` (`terminals.write`).
- `oxy.terminals.onDidWriteData(id, listener)` (`terminals.read-output`): the raw output of a terminal.
- `oxy.terminals.getListeningPorts(id)` (`terminals.read-metadata`): TCP ports of the terminal's process tree.
- `TerminalMeta`: `cwd`, `background`, `foreground`, `shellIntegration`, `command` and `lastCommand`.
- File openers receive `line`/`column` params from terminal links and `{ type: 'oxy:reveal' }` messages when their file
  is opened again.

## 0.1.3

- `contributes.panels[].showInAddMenu`: lists a panel under Tools in the workspace's "+" menu and the right sidebar's
  "Add tool" menu. Panels can also be moved into the right sidebar, where they keep their `oxy.setState` state.

## 0.1.2

- `oxy.agents.reportState(terminalId, { state, waitingFor?, sessionId? })` (`agents.annotate`): agent states reported
  by the agent itself (the `hook` source, highest priority).

## 0.1.1

- `oxy.ui.showQuickPick(items, { placeholder })`: a fuzzy-filtered pick in the command palette.

## 0.1.0

- First version: projects, terminals (metadata, create, sendText, environment), agents, git status, UI (views, panels,
  status bar items, notifications, open external/editor), commands, settings, storage and logging.
- `EnvironmentCollection.append/prepend` accept `{ separator }`, inserted only when the variable already has a value.
