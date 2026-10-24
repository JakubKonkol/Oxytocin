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
- **Prompt-time Code Map pointers** (optional, per project, off by default): in a project with Code Map on and
  *Project settings → Code Map → Suggest code locations with each prompt* checked, every `UserPromptSubmit` hook also asks
  Oxytocin for up to 3 file pointers (`path:start-end kind name`, no code) and returns them as `additionalContext`
  (together with the once-per-session resources brief), so the agent often needs no Code Map tool call. Oxytocin adds
  pointers only when the top match is strong (matched a symbol name, or at least 60% of the prompt's weighted terms),
  never repeats a pointer within a session, skips short prompts and harness text (`<task-notification>` and similar),
  and gives up after 1 s (the hook itself times out after 5 s), so a prompt is never delayed noticeably. The bridge
  plugin therefore declares the `code-map.read` permission (the core command `oxytocin.codeMap.promptContext` checks
  it); `SessionEnd` makes Oxytocin forget what a session was shown.
- **Privacy of prompts.** Without the setting, Oxytocin discards the prompt without looking at it. With it, the prompt
  text is read **only on this computer** (loopback, token-authenticated), cut to 4,000 characters, used for that one
  local lookup and **never stored or logged** (logs hold only counts and timings, at debug level). The pointers become
  part of what Claude Code sends to its model; the prompt itself is not sent anywhere by Oxytocin.
