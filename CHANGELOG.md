# Changelog

All notable changes to Oxytocin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/) (0.x until the plugin API is stable).

## [0.9.0] - 2026-10-09

### Added

- **Git actions in the CHANGES section.** Every file and folder has a checkbox that stages or unstages it (a folder
  shows when only some of its files are staged); hovering a row offers *Open file* and *Discard changes*. Above the
  list a commit message box and a **Commit** button commit what is staged — or, with nothing staged, every change —
  and its menu adds *Commit & Push*, *Amend Last Commit* and *Undo Last Commit* (the commit's changes go back to the
  staging area). The branch name opens a menu to switch to another branch, create one, stash the changes and pop the
  stash; next to it **pull** (↓ with the number of new commits), **push** (↑ with the commits to push), **fetch**, or
  **Publish** for a branch without an upstream. The section's **…** menu stages, unstages or discards everything and
  syncs; the context menus of files and folders have the same actions. Git's own message explains any failure.
- **Review.** *Review all changes* (the new button of the CHANGES section, *Review in Context* in a file's menu, or
  *Git: Review All Changes*) opens every changed file's diff one below the other, with a file list, *Viewed* marks
  that collapse a file until it changes again, a progress bar, and per file *Staged*, *Discard*, *Open file* and
  *Ask agent*. Select code in any diff and choose **+ Comment** (Ctrl+Alt+M) to add a review comment; comments are
  marked in the diffs and listed in the review, and **Send comments** hands all of them to an agent as one prompt with
  the code they are about. *Ask agent to review* asks an agent to review every change.
- **Ask agent about code.** Select code in a diff or a file and press **Ctrl+L** (or **✦ Ask agent** next to the
  selection, or the context menu): a dialog shows the code, offers *Fix*, *Explain*, *Review*, *Refactor*, *Add
  tests* and *Document* or your own instruction, and sends the prompt with the file, the lines and the code to the
  running agent you pick — pressed Enter right away, or only pasted (`editor.askAgent.submit`). *Copy* and *Add to
  scratchpad* keep it for later. Files and changed files have *Ask Agent About…* in their context menus.
- **Built-in code editor and FILES section.** The new **FILES** section of the left sidebar (collapsed at first)
  browses the project: folders load as you open them, files git ignores are dimmed, changed files have their git
  colour and letter, and it follows files created or deleted on disk. Files open in a Monaco editor tab (a preview
  tab until you edit it or double-click it) with syntax highlighting, find and replace, multiple cursors, folding,
  sticky scroll and the minimap; save with **Ctrl+S**. A file without edits follows changes on disk (an agent
  writing it); with edits Oxytocin shows a banner (*Reload* or *Keep mine*) and never overwrites a newer file without
  asking. Closing a tab or quitting with unsaved edits asks to save them. The FILES menus create files and folders,
  rename, delete (to the trash), copy paths and open files to the side or in the external editor.
- **Quick Open finds every file** of the active project (`Ctrl+Shift+O`; `%` lists files only, *Files: Go to File…*).
- `editor.preset` **`oxytocin`**: *Open in external editor* and terminal file links that go to the editor open files
  in the built-in editor instead. New settings `editor.code.fontSize`, `editor.code.wordWrap`, `editor.code.minimap` and
  `editor.code.maxFileSizeMb`.

### Changed

- Diffs can be edited: the right side (the file on disk) is editable, the arrows between the sides revert single
  changes and **Ctrl+S** saves. The diff toolbar adds *Staged*, *Discard changes*, *Ask agent*, *Review all changes*
  and *Open file* (the built-in editor at the current change); *Open in external editor* keeps opening your IDE.
- Diff and code editor tabs carry an icon so the two tabs of one file are told apart.

## [0.8.2] - 2026-10-07

### Added

- **Custom scripts in the Run tool.** **+** now offers *Run Profile…* and *Custom Script…*. A custom script is an
  existing script file of the project — a `.bat`, `.cmd`, `.ps1`, `.sh` (typed with suggestions, or picked with
  *Choose…*) — or a script written right in the form (batch, PowerShell or shell). It is listed below the detected
  apps, which are found as before, and runs, stops and shows its logs like them. Two options per script: *Visible to
  AI agents* (on by default; off, the agents' Run tools neither list nor start it) and *Always run in a new terminal
  tab* (every run opens a new terminal tab instead of a background terminal). *Open Script* in the row's menu opens
  the file.
- **Scripts that wait for a key.** A script that ends with `PAUSE` ("Press any key to continue . . .") shows *waiting
  for input* with a **Continue** button (also in its notification); agents continue it with `run_answer_prompt` and
  an empty answer.

## [0.8.1] - 2026-10-02

### Added

- **Ensemble quick start.** A new task now starts from one prompt: describe what the team should do, pick who works
  on it (the planner always leads; implementer, reviewer, API researcher, researcher and tester are toggles), choose
  whether you approve the plan and optionally a test command, and press *Start* (or Ctrl+Enter). The pipeline follows
  from the team. *Customize first* opens the same task in the builder — models, a precise prompt per role, stages —
  and the templates are still one click away under *From a template*.
- **The planner delegates.** Agents hand parts of their work to teammates with the new `oxy_ensemble_delegate` tool:
  the planner breaks the task down, sends research to its helpers (in parallel), waits for their reports — delivered
  to it as messages, without reminders meanwhile — and writes the plan on top of them. Helpers appear under the stage
  in the Flow view ("delegated to"), the waiting agent shows "waiting for …", and agents outside the pipeline are
  marked as helpers in the builder.
- **API researcher**, a new role: it maps the endpoints a task needs — method and path, parameters, authentication,
  request and response shapes as TypeScript types with examples, errors and pagination — from an OpenAPI document,
  a URL in the prompt or the project's APIs, which Ensemble agents now call through Oxytocin's resource tools
  (`oxy_project_resources`, `oxy_api_describe`, `oxy_api_request` and the database tools) with the access rules from
  *Project settings*. In Claude Code it may read web pages without asking.

### Changed

- The model of an agent is chosen from a list of real model ids — `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-fable-5-1`, `claude-haiku-4-5`, the aliases and older models (and the current ids for Codex CLI, Gemini CLI
  and OpenCode) — or typed in with *Other…*. The role presets use the full ids.

### Fixed

- **Agents always know the task.** An agent started without the brief and could ask what the task was about: its
  first message only said to fetch the details with a tool, and the CLI connects its MCP tools in the background
  after start-up. Now the brief is part of every agent's system prompt, each assignment is typed into the agent with
  its whole context (instruction, brief, the results of earlier stages), and the first message waits until the
  agent's CLI has connected to Ensemble (up to 20 seconds). Codex CLI, Gemini CLI and OpenCode also get the Ensemble
  rules with their first assignment. Long messages are typed in slices; on Windows they are typed as one line (line
  breaks shown as ↵), so a line break can never send half a message.
- The model field offered only the models matching what was already typed (with `opus` set: just `opus` and
  `opus[1m]`).

## [0.8.0] - 2026-10-02

### Added

- **Ensemble: tasks run by a team of AI agents.** A new tool in the "+" menu of a project's workspace. Describe a
  task, pick a template (*Feature*, *Bugfix*, *Review only*, *Research spike*, *Refactor with tests*, *Second
  opinion* or *Blank*) and adjust the team and the pipeline in the builder: every agent has its own CLI (Claude Code,
  Codex CLI, Gemini CLI, OpenCode or a custom command), model, effort, permission mode, role prompt and can be made
  read-only; stages are agent steps, *Implement ⇄ Review* loops with a round limit, parallel reviewers, tests
  (a command that sends failures back to the implementer) and gates where you approve, edit the plan or request
  changes. Checks and a prompt preview show what each agent will get before you start.
- **Runs you can watch and steer.** The *Flow* view shows the stages, the agents with their live state, what each
  agent handed to the next one and every decision of the conductor; click an agent to peek at its terminal, *Take
  over* to type into it yourself and *Hand back* when done. *Agents* shows all agent terminals side by side,
  *Activity* the whole timeline with a live log, *Changes* the diff of the task (or of one stage) and *Artifacts*
  the plans, reviews and results. Pause, resume, stop, send an agent a message or mark a stage as done; a run that
  was active when Oxytocin closed can be resumed with the agents' sessions.
- **Agents talk to each other — and to you.** Agents ask teammates or you questions; yours wait in the *Needs you*
  inbox together with open gates, and an optional advisor agent can be consulted at chosen moments. A status bar
  item, the attention badge and Ctrl+Shift+J take you to what needs you; OS notifications arrive when the window is
  in the background.
- **Its own worktree per task.** By default a task runs on a new branch in a git worktree next to the repository
  (setup commands and copied files such as `.env` are configurable; `ensemble.worktreeRoot` moves the folder),
  with a checkpoint commit after each stage, so your checkout is never touched. *Finish* merges the branch, squashes
  it into one commit, keeps the branch or discards everything; *Copy summary* gives a Markdown report for a pull
  request. Read-only teams can also work in the current checkout.
- **Costs and limits.** With the Usage Monitor running, every agent card shows what its sessions cost and the task
  shows the total; a budget, a maximum running time and the number of agents working at once pause or queue the
  task. The Usage Monitor offers the command `oxytocin.usage-monitor.totals` for this.
- **Isolated by design.** Models, efforts and prompts are passed per session on the command line: your CLI
  settings files, default model and other terminals stay exactly as they were. Agents reach Ensemble through a
  separate endpoint of Oxytocin's MCP server (`/mcp/ensemble`, with a token per agent); the tools other agents see
  are unchanged, and nothing runs unless you start a task. Settings `ensemble.worktreeRoot` and `ensemble.commands`
  (the command per CLI).

### Fixed

- An API resource whose base URL comes from a Project Runner profile now resolves to the running app's URL; it
  always fell back to the fallback URL before.

## [0.7.1] - 2026-10-01

### Added

- Plugin API 0.1.6: `oxy.ui.showNotification({ …, signal })` withdraws a notification with buttons (it closes and
  resolves `undefined`); notifications with buttons that time out now close instead of staying on screen.

### Fixed

- **Run: a question of a starting app is asked once.** When an app asks something while starting (Angular's "Port
  4200 is already in use… (Y/n)"), the question appeared both in the Run view and as a notification, and answering
  one left the other behind, its buttons sometimes doing nothing. Now the notification only appears when no Run view
  on screen shows the question, closes as soon as the question is answered (in the view, the notification or the
  terminal) or the Run view is opened, and its buttons keep working when the app redraws the question.
- **A crashed window comes back by itself.** If the window's renderer crashes (out of memory, a GPU or driver
  problem), Oxytocin reloads it within a second; terminals, agents and running processes keep running and reconnect
  with their output. After three crashes within a minute it asks whether to reload or quit instead of looping.
- **A hung window can be reloaded.** When the window stops responding, a dialog offers *Wait* or *Reload* and
  closes by itself if the window recovers.
- **No more accidental reloads, DevTools or closing from stray shortcuts.** Electron's built-in menu acted on keys
  the page did not handle: Ctrl+R / Cmd+R reloaded the whole window outside terminals, Ctrl+Shift+I opened the
  DevTools and Ctrl+W asked to quit. Oxytocin now has its own menu: on macOS the native menu bar (*About*,
  *Check for Updates…*, *Settings…* (Cmd+,), *Command Palette…*, editing, window and *Show Logs Folder* items); on
  Windows and Linux only full screen (F11) remains.
- A failed start now shows the error and exits instead of leaving an invisible process behind, which made new starts
  do nothing until it was ended in the task manager.
- In development builds each event from the app (toasts, "new terminal" from plugins) was handled twice.
- Unhandled errors are logged once instead of twice, and crashes of Electron's helper processes (GPU, network) are
  logged.

## [0.7.0] - 2026-09-30

### Added

- **Databases and APIs for your agents.** *Project settings* (right-click a project) is now a larger dialog with tabs,
  and describes the project's **resources**: databases (PostgreSQL, CockroachDB, SQL Server, MySQL, MariaDB, MongoDB,
  SQLite, Redis/Valkey, ClickHouse, Oracle), HTTP APIs (base URL or a Run profile's URL, bearer/basic/API-key/header
  authentication, OpenAPI), log files, links and related projects. *Test connection* shows the server version and
  latency or a clear error (authentication, host unreachable, TLS, missing database, timeout); *Import from project…*
  finds connection strings in `.env`, `appsettings*.json`, Spring `application.properties`/`.yml`, docker-compose and
  Prisma files and either references the env variable (nothing copied) or copies the connection into Oxytocin.
- **The bridge.** Agents use the resources through new tools of Oxytocin's MCP server — `oxy_project_resources`,
  `oxy_db_schema`, `oxy_db_query`, `oxy_mongo`, `oxy_redis`, `oxy_api_describe`, `oxy_api_request` and
  `oxy_logs_tail` — which are only offered once a project has such a resource. Oxytocin adds the credentials (they
  never reach the agent) and enforces what you allowed per database: **read-only** (the default: a real SQL parser
  per dialect lets through only plain reads — one statement, built-in functions, no `SELECT … INTO`, `FOR UPDATE`,
  sleeping, file or network functions — and reads also run in read-only transactions), **ask before writes** (every
  other statement is shown to you in full, with *Allow* / *Deny*) or **read-write** (still asking before `DROP`,
  `TRUNCATE` and `UPDATE`/`DELETE` without `WHERE`); production databases cannot be read-write. MongoDB and Redis get
  operation and command allowlists. APIs only receive the methods and paths you allow, only at their own origin.
  Results are capped (rows, bytes, time) and say how many rows exist; columns such as `password_hash` or `api_token`
  are masked (`***`); secrets never appear in errors.
- **Secrets are encrypted** with the operating system's keychain (DPAPI, Keychain, libsecret/KWallet) and can only be
  written from the dialog, never read back. On Linux without a keyring the dialog says that they are only obfuscated.
- **Agents are told about the resources:** in the MCP server's instructions (for the project of the terminal they run
  in), with the first prompt of every Claude Code session (through the Claude Code Bridge hooks), and — when you
  choose it on the new *Agents* tab — in a managed block of `AGENTS.md` or `CLAUDE.md`. The *Agents* tab also shows the
  brief and the project's recent tool calls with their queries.
- Resource tool calls keep the query or request line in the call log (Settings → Agent Tools), never the results.
- *Save to repository* writes the resources without secrets and production hosts to `.oxytocin/project.json`; when a
  repository with this file is opened, Oxytocin asks once per version before using it.
- Links of a project appear in its context menu; related projects share the resources they mark *Share with related
  projects*, and the *Related projects* tab suggests `claude --add-dir` for their code.
- Database drivers run in a new **Connections Host** process that starts on first use and stops after 10 idle
  minutes; its connection pools close after 5 idle minutes, so projects without resources pay nothing.

## [0.6.5] - 2026-09-30

### Added

- **One MCP server for your AI agents.** Oxytocin runs a local MCP server (`oxytocin`, 127.0.0.1 only, protected by a
  token) that Claude Code, Codex CLI, Cursor and other agents connect to once. It offers Oxytocin's own tools — list
  the projects and terminals, read the output of another terminal (a dev server, a test run), notify you, ask you a
  question in a dialog, open a file for you — plus the tools of your plugins. When you turn a plugin on or off, its
  tools appear or disappear in running agent sessions without reconnecting (for agents that support MCP's live tool
  updates; others see them in their next session).
- **Settings → Agent Tools**: the server's status, **Connect Claude Code** (one click, no re-connecting when plugins
  change), copyable config for other clients, *Reset token*, every tool with an on/off switch and *Run without
  asking* / *Ask first* / *Blocked*, and a log of recent calls (without their arguments). Tools that change or delete
  something ask first by default: *Allow once*, *Always allow* or *Deny* — also with a system notification when
  Oxytocin is in the background. Open it with *Agent Tools: Open* in the command palette.
- Oxytocin knows which terminal an agent calls from (Claude Code passes it along), so tools act on the right project
  without being told the folder.
- **Plugins can give agents tools** (plugin API 0.1.5): `contributes.mcp` with a tool prefix and the tools, the
  `mcp.tools` permission (the consent dialog lists the tools), `onMcpTool:<name>` activation and
  `oxy.mcp.registerTool(…)`, also for tools added at runtime. See *Tools for AI agents* in the plugin docs.

### Changed

- **Project Runner: its agent tools moved into Oxytocin's MCP server** as `run_list_profiles`, `run_start_profile`,
  `run_restart_profile`, `run_stop_profile`, `run_get_logs`, `run_answer_prompt` and `run_add_profile`. The Run tool's
  *Connect Claude Code* button and the *Run: Connect Claude Code (MCP)* command are gone: **Agent Tools** at the bottom
  of the Run tool opens the new settings. If you connected Claude Code to the old `oxytocin-runner` server, it keeps
  working for this release; **Connect Claude Code** in Agent Tools replaces it (and removes the old entry from Claude
  Code). `projectRunner.mcp.enabled` and `projectRunner.mcp.port` only affect that old server and will be removed;
  `projectRunner.claudeCommand` is replaced by `mcp.claudeCommand`.

### Fixed

- **Terminals restored after a restart** no longer show old prompt lines several times, lose the last lines of the
  restored output or leave the cursor invisible. On Windows the restored output now sits in the scrollback above the
  *Session restored* line, and the new shell starts on a clean screen below it (ConPTY expects an empty screen). The
  copy of each terminal that Oxytocin keeps for restoring resizes the same way as the visible terminal, so it no
  longer collects stale lines when a panel grows.

## [0.6.0] - 2026-09-29

### Added

- **One scratchpad per project.** The scratchpad's toolbar has **Share across projects** (on by default, as before).
  Turn it off and every project gets its own scratchpad; the current project keeps what you see. Turning it on again
  asks first when other projects have notes, because their scratchpads are replaced by the current one. Scratchpads
  are kept across restarts, also when you quit right after typing.
- **Run: apps that ask something while starting.** When an app waits for an answer (e.g. Angular's *"Port 4200 is
  already in use. Would you like to use a different port? (Y/n)"*), the Run tool shows *waiting for input* with the
  question and **Yes** / **No** (or a text answer) and **Open terminal**, the status bar says so, and a notification
  offers the same answers — instead of an endless *starting*. Agents see the question (`waitingForInput`) and can
  answer it with the new `answer_run_prompt` MCP tool.

### Changed

- **Oxytocin's own dialogs.** Quitting with running processes asks in an in-app dialog (listing the processes, with
  *Don't ask again*) instead of the system message box. Confirmations have a new look: an icon, the affected items as
  a list and a short fade-in.
- Plugin notifications show their action buttons (`oxy.ui.showNotification({ actions })`) and report the clicked one.

### Fixed

- **Rename** from a project's context menu no longer closes the name field right after it opened.
- Stopping an app (the Run tool's **Stop**, or Ctrl+C in a terminal) no longer shows *"Command failed"* when the app
  exits with an error code on Ctrl+C (e.g. `ng serve`); a terminal killed on request no longer reports *"Process
  exited with code …"*.

## [0.5.3] - 2026-09-29

### Changed

- **The Run tool is shown only when you add it.** The Project Runner no longer has a fixed section in the left sidebar:
  add **Run** from **Add tool** in the right sidebar (or the workspace's **+** menu). If you used the Run section,
  add it once again. Apps, run profiles, the status bar count and the MCP server work as before.
- **Tools move between the sidebars.** Every tool of the right sidebar (Run, the scratchpad, the JSON Formatter, plugin
  panels) moves to the left sidebar with its **Move to left sidebar** button or by dragging its section header there,
  and back the same way; a workspace tab's menu has **Move to left sidebar** too. The place is kept across restarts.

### Fixed

- Menus of plugin views (e.g. **⋯** of an app in the Run tool) no longer open partly off-screen near the right or
  bottom edge of the window; they open to the left or above instead. **Escape** closes them.
- *Run: Show Run Panel* (and the Run status bar item) reveals the Run tool where it is instead of opening a second one.

## [0.5.2] - 2026-09-29

### Fixed

- **Auto-update on Windows:** updates failed to download ("Cannot download … 0.5.1") because the installer was
  uploaded as `Oxytocin.Setup.x.y.z.exe` while the update manifest pointed at `Oxytocin-Setup-x.y.z.exe`. The installer
  is now named without spaces, and the release workflow checks that every file the update manifests list exists.
  Installed versions pick up 0.5.2 normally.
- The README release badge no longer shows "no releases or repo not found".
- **Scrollback after a restart** was sometimes lost (reliably on slower Windows machines): a layout save from the
  window that arrived while Oxytocin was quitting (a shell exiting, a title changing) overwrote the record of the
  saved terminal contents. Those saves now keep it. Terminals are also snapshotted all at once, so quitting with
  several terminals is faster.

### Changed

- **Update progress:** clicking the status bar entry while an update downloads opens a popover with a progress bar,
  the downloaded size and the speed. When the download finishes it offers **Install now** (restarts Oxytocin) or
  **On restart** (installs the next time you quit). A failed download shows *Update failed* in the status bar and
  the error with a **Retry** button in the popover.

## [0.5.1] - 2026-09-28

### Fixed

- **Project Runner on Windows:** agents' working directories are recognised in any spelling — 8.3 short names
  (`C:\Users\RUNNER~1`), symlinks and junctions, Git Bash (`/c/work/app`) and WSL (`/mnt/c/…`) paths — so the MCP
  tools find the project. The Run view no longer misses the active project when the app starts slowly.
- **Listening ports on localized Windows** (the state column of `netstat` is translated, e.g. *NASŁUCHIWANIE*) and on
  IPv6 (Vite listening on `::1`): the Run view shows the app's port again.
- **Runs are sturdier:** a double click or an agent starting an app that is already starting no longer opens a
  second terminal; *Stop* during start-up cancels it; the terminal is only reused while its shell is in the app's
  folder; apps that keep running are taken over again after the plugin restarts (a Plugin Host restart, reloading
  or re-enabling the plugin). Errors of Run/Stop/Restart are shown in the Run view.
- **File Preview** renders in a worker thread: previewing a large file no longer freezes the other built-in plugins
  (Usage Monitor, Project Runner), and a render that takes too long is cancelled.
- **Usage Monitor:** turning on the Claude subscription limits right after start-up is no longer lost.
- The *Connect Claude Code* state checks the registered port, and the `claude` CLI is only asked when a Run view
  opens (not at every start of Oxytocin).
- Terminal links resolve to real paths (symlinks, short names), so previews open for files of symlinked projects.

### Security

- The MCP server rejects requests whose `Host` is not a loopback name (DNS rebinding).
- Web links behind OSC 8 hyperlinks in terminals (their target is hidden behind the text) open with
  `Ctrl/⌘+click` only, like file links.
- A stray promise rejection no longer takes down the PTY Host (every terminal) or shows Electron's error dialog; it is
  logged.

## [0.5.0] - 2026-09-28

### Added

- **Previews from terminal links.** `Ctrl+click` (`⌘+click`) a file path in a terminal — `CLAUDE.md`, `src/app.ts:42`,
  a `file://` hyperlink — to open it in a **preview tab**: Markdown rendered, code highlighted with line numbers and
  scrolled to the line. A file that is already open is revealed instead of opened twice. Like every tool, a preview
  moves into the right sidebar by drag and drop and comes back after a restart. `Ctrl+Shift+click` opens the editor;
  the new `terminal.fileLinks.open` setting swaps the two.
- **Project Runner** (built-in plugin): detects the runnable apps of a project — Node.js scripts with their framework
  (Next.js, Vite, Angular, NestJS, …), .NET web/worker/console projects with their launch URLs, Django, FastAPI, Flask,
  Streamlit, Go, Rust, Spring Boot, Laravel, Rails, Deno, Docker Compose and Makefile targets — and runs them with one
  click from the new **Run** section (also a tool for the workspace and the right sidebar). Each app shows its status,
  the URL it serves (from its output or its listening ports) and its exit code; **Show logs** opens its terminal,
  **Stop** interrupts it. Edit detected apps or add your own **run profiles** (command, folder, environment) per
  project; they are kept across restarts. The status bar counts running apps.
- **MCP server for agents** in the Project Runner: Claude Code (or any MCP client) lists, starts, restarts and stops
  run profiles and reads their logs through a local, token-protected server; **Connect Claude Code** registers it.
  Apps started by an agent are marked in the Run section. Turn it off with `projectRunner.mcp.enabled`.
- Plugin API 0.1.4: background terminals (`create({ reveal: false, env })`, `show`), `kill`, `close`,
  `onDidWriteData`, `getListeningPorts`, richer `TerminalMeta` (cwd, running and last command) and line positions for
  file openers.

### Changed

- **Markdown Preview is now File Preview:** it also previews code and text files, and every code file gets **Open
  Preview** in the Changes list.
- Terminal file links also resolve paths relative to the project root, and typographic quotes („…”, “…”) around a
  file name no longer hide the link.

## [0.4.0] - 2026-09-28

### Added

- **Tools in the workspace.** The **+** of every tab group is now a menu: a new terminal (with the default or any
  other profile) or a **tool** — the scratchpad, the JSON Formatter or any plugin panel that declares
  `showInAddMenu`. Tools open next to the terminals and split, stack, float and move by drag and drop like them.
- **Modular right sidebar.** Drag a tool's tab onto the right sidebar (or use *Move to right sidebar* in the tab menu)
  to dock it there, and drag its section header back into the layout (or use *Move to workspace*). Every section can
  be closed, reordered and has **Add tool**; with every tool closed the sidebar offers to add one. The tools, their
  order and their state are kept across restarts.
- **Scratchpad formatting and settings.** A Markdown toolbar (bold, italic, strikethrough, code, code block, heading,
  lists, checklist, quote) with `Ctrl+B` / `Ctrl+I` / `Ctrl+E`, lists that continue on Enter, and a settings button
  for the font (mono, sans, serif), size, line height, line wrapping, spell checking and the toolbar itself — also in
  *Settings → Scratchpad*. The scratchpad can open as a workspace panel too; every copy edits the same notes.
- **JSON Formatter** (built-in plugin): format with 2 or 4 spaces or tabs, sort keys, minify, copy, and errors with
  their line and column.
- **Usage settings button.** A gear in the top-right corner of the Usage card opens the dashboard's **Settings** tab
  (billing, Claude subscription limits, prices), previously only reachable through the status bar.
- Plugin API 0.1.3: `contributes.panels[].showInAddMenu`.

### Changed

- **Usage Monitor with subscription billing:** when every agent in use is billed by subscription, the Usage card
  hides the API-equivalent costs (today's cost and tokens, burn rate, session and project costs) and shows the plan
  limits — or a link to turn them on. The status bar shows today's tokens instead of a cost when no limits are
  reported. The dashboard's *Pricing* tab is now called *Settings*.

## [0.3.1] - 2026-09-27

### Changed

- **Releases are built and published by GitHub Actions.** *Run workflow* on the Release workflow with a version
  bumps it, runs the full test suite and publishes the release with the Windows installer; the Linux and macOS
  packages are added when their builds succeed. Pushes to `main` only run the fast checks on Windows.

### Fixed

- **Windows:** a command started in a terminal shows as running right away again. Since 0.3.0 the busy-terminal
  sampling every 2 s could delay it by up to two seconds; the process tree is now sampled quickly for a few seconds
  after each command starts.

## [0.3.0] - 2026-09-27

### Added

- **Right sidebar.** A second column on the right of the workspace, as wide as the left sidebar by default
  (resizable, collapsible sections). Toggle it with the new title bar button or `Ctrl+Alt+B`
  (*View: Toggle Right Sidebar*).
- **Scratchpad** in the right sidebar for notes and prompt drafts, kept across restarts. **Send to agent**
  (`Ctrl+Enter` in the scratchpad) pastes the text into a running AI agent terminal without submitting it, so you can
  review it and press Enter. With a single running agent it goes there; with several it goes to the one you last
  used, or you pick one from the menu next to the button. *View: Focus Scratchpad* is in the command palette.
- **Settings button** in the title bar (next to the window controls). Settings were previously only reachable
  through the Oxytocin logo menu or `Ctrl+,`.

### Changed

- **Faster on Windows:** shell and agent detection (PATH lookups, `reg`, `wsl -l`) now runs in parallel and starts
  while the window loads, so the first terminal opens sooner. The process tree of busy terminals is sampled every
  2 s instead of every second, which halves the `fastlist.exe` spawns while agents are printing.

### Fixed

- A panel opened while a project's first terminal is still starting (for example Settings from the start-up
  "invalid value" notification) is no longer covered by the new terminal tab.

## [0.2.0] - 2026-09-27

### Added

- **Usage Monitor: Claude subscription limits.** An opt-in setting (Usage dashboard → Pricing → Claude
  subscription limits) shows the real 5-hour and weekly limits of a Claude Pro/Max plan, which Claude Code
  reports to its status line. Oxytocin sets a status line command in Claude Code's `settings.json`; a status line
  you already have keeps working and comes back when you turn the option off. With Claude Code billing set to
  Subscription, the limits get their own bars in the Usage sidebar (with reset times) and replace the cost in the
  status bar (`5h 24% · week 41%`).

## [0.1.0] - 2026-09-27

First MVP release: a desktop hub for developers who work with AI coding agents in the terminal.

### Added

- **Projects:** folders as projects with colours, pinning, drag-and-drop ordering and live status dots (agent
  working, waiting for you, process running, error); instant switching that keeps every process running; one
  workspace layout per project, restored after a restart (including terminal scrollback).
- **Terminals:** node-pty + xterm.js (WebGL) in a dockview center area with tabs, splits, drag and drop and preview
  tabs; shell detection (PowerShell, cmd, Git Bash, WSL, bash/zsh/fish) and agent launch profiles; Shift+Enter for
  newlines in agents, clipboard (image pastes are forwarded to agents), file links, search, flow control and a headless mirror for fast
  rehydration.
- **AI agents:** detection of Claude Code, Codex CLI, Gemini CLI, Aider and others from the process tree, Claude
  Code session registry and terminal signals; "working / waiting for you / idle" states, attention badge, OS
  notifications and a quit guard for running agents.
- **Changes:** live tree of files changed since `HEAD` (git porcelain v2 + file watching) with line counts, a
  Monaco diff viewer that updates while agents write, and "Open in editor" presets (VS Code, Cursor, Windsurf,
  Zed, JetBrains, Sublime Text, terminal editors, …).
- **Plugins:** HTML/JS/CSS plugins in sandboxed iframes with a backend in a separate Plugin Host process; sidebar
  views, center panels, status bar items, commands, file openers, terminal environment contributions, terminal
  profiles and agent rules; a minimal plugin manager with reload, logs and a developer mode; `@oxytocin/plugin-api`
  and `@oxytocin/plugin-sdk`.
- **Markdown Preview** (built-in plugin): live preview of plans and reports written by agents, with syntax
  highlighting, task lists, inlined images and link navigation.
- **Usage Monitor** (built-in plugin): tokens and USD cost of Claude Code, Codex CLI and Gemini CLI from their local
  logs (and optional OpenTelemetry), attributed to projects and terminals; live sessions, burn rate, 5-hour blocks,
  budgets with notifications, a dashboard with charts, sessions, budgets, pricing (LiteLLM prices, daily refresh,
  your own rates) and data sources. Only usage metadata is stored, locally.
- About dialog (version, MIT License) and Third-Party Notices.
- **Command palette** (`Ctrl+Shift+P`) and **Quick Open** (`Ctrl+Shift+O`: projects, terminals, changed files), also for
  plugins (`oxy.ui.showQuickPick`).
- **Keyboard shortcuts editor** and `keybindings.json` overrides with conflict detection.
- **Settings UI** generated from the settings schema (plugin settings included), with search, `@modified` and
  `@problems` filters.
- **Light theme** and "follow the system" (`appearance.theme`), also for plugin views.
- **Shell integration** for bash, zsh, fish and PowerShell: command start/finish marks, exit codes and
  "command finished" notifications.
- **Agent session resume** after a restart, a **project settings** dialog (name, colour, icon, environment, startup
  terminals, default profile) and **floating panel groups**.
- **User plugins:** install from a folder or a .zip (Plugins → Install…), a consent dialog with the plugin's
  permissions before it first runs, uninstall; installed and developer plugins run in their own Plugin Host.
- **`create-oxytocin-plugin`** (`npm create oxytocin-plugin`): a TypeScript plugin template (vanilla or React) with
  watch builds and packaging, and a [plugin developer guide](docs/plugins/README.md).
- **Claude Code Bridge** (built-in plugin): with the user's consent it installs Claude Code `http` hooks that report
  exact agent states (working, waiting for permission, finished) to Oxytocin; plugin API 0.1.2 adds
  `oxy.agents.reportState`.
- **Auto-update** from GitHub Releases (`latest` / `beta` channels): background download, installed when you quit
  or click *Restart to update* — never an automatic restart.
- Release pipeline: Windows/macOS code signing and notarization (activated by repository secrets) and hardened
  Electron fuses.

### Known limitations

- Builds are not code-signed yet (Windows SmartScreen and macOS Gatekeeper warn on first start).
- The Codex CLI log parser follows the documented format and still needs verification against more CLI versions.
