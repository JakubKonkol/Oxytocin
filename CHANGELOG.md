# Changelog

All notable changes to Oxytocin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/) (0.x until the plugin API is stable).

## [Unreleased]

## [0.3.1] - 2026-09-27

### Changed

- **Releases are built and published by GitHub Actions.** Pushing a version tag runs the full test suite and
  publishes the release with the Windows installer; the Linux and macOS packages are added when their builds
  succeed. Pushes to `main` only run the fast checks on Windows.

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
