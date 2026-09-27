# Changelog

All notable changes to Oxytocin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/) (0.x until the plugin API is stable).

## [Unreleased]

### Added

- **Command palette** (`Ctrl+Shift+P`) and **Quick Open** (`Ctrl+P`: projects, terminals, changed files), also for
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
- **Auto-update** from GitHub Releases (`latest` / `beta` channels): background download, installed when you quit
  or click *Restart to update* — never an automatic restart.
- Release pipeline: Windows/macOS code signing and notarization (activated by repository secrets) and hardened
  Electron fuses.

### Fixed

- Terminals default to a UTF-8 locale when the environment has none.
- A half-written `settings.json` (external editor) no longer resets the settings or gets moved aside.

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

### Known limitations

- Builds are not code-signed yet (Windows SmartScreen and macOS Gatekeeper warn); auto-update comes later.
- Dark theme only; the command palette, keyboard shortcut editor and settings UI come with v0.2.
- The Codex CLI log parser follows the documented format and still needs verification against more CLI versions.
