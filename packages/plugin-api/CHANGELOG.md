# Changelog

## 0.1.2

- `oxy.agents.reportState(terminalId, { state, waitingFor?, sessionId? })` (`agents.annotate`): agent states reported
  by the agent itself (the `hook` source, highest priority).

## 0.1.1

- `oxy.ui.showQuickPick(items, { placeholder })`: a fuzzy-filtered pick in the command palette.

## 0.1.0

- First version: projects, terminals (metadata, create, sendText, environment), agents, git status, UI (views, panels,
  status bar items, notifications, open external/editor), commands, settings, storage and logging.
- `EnvironmentCollection.append/prepend` accept `{ separator }`, inserted only when the variable already has a value.
