# Changelog

All notable changes to Oxytocin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/) (0.x until the plugin API is stable).

## [0.5.2] - 2026-09-29

### Fixed

- **Auto-update on Windows:** updates failed to download ("Cannot download … 0.5.1") because the installer was
  uploaded as `Oxytocin.Setup.x.y.z.exe` while the update manifest pointed at `Oxytocin-Setup-x.y.z.exe`. The installer
  is now named without spaces, and the release workflow checks that every file the update manifests list exists.
  Installed versions pick up 0.5.2 normally.
- The README release badge no longer shows "no releases or repo not found".

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
