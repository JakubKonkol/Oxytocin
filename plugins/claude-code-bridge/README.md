# Claude Code Bridge

Built-in Oxytocin plugin: exact Claude Code states through Claude Code hooks.

- The backend listens on `127.0.0.1:<claudeBridge.port>` (default 47285) and gives every terminal a secret
  `OXYTOCIN_BRIDGE_TOKEN`.
- **Claude Code Bridge: Set Up** opens a panel that explains what happens and, when the user clicks *Install in
  Claude Code*, writes a local Claude Code marketplace (`oxytocin`) with the `oxytocin-bridge` plugin into the plugin's
  data folder and runs `claude plugin marketplace add <folder>` and `claude plugin install oxytocin-bridge@oxytocin`.
  *Remove* runs `claude plugin marketplace remove oxytocin`. The plugin has no `version`, so Claude Code loads it in
  place and a changed port applies to new sessions (verified with Claude Code 2.1.283: validate, install, list,
  remove).
- The plugin's `http` hooks (`UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`,
  `SessionEnd`) send the token and `OXYTOCIN_TERMINAL_ID` as headers; the endpoint maps them to agent states
  (`oxy.agents.reportState`, the highest-priority `hook` source). Hook URLs cannot contain variables, hence the fixed
  port. `SessionStart` supports only command hooks, so the session id comes with the first event of a session.
