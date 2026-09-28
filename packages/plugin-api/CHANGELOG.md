# Changelog

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
