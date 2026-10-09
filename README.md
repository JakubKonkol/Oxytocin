<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/brand/svg/logo-horizontal-on-dark.svg" />
    <img alt="Oxytocin" src="resources/brand/svg/logo-horizontal-on-light.svg" width="360" />
  </picture>
</p>

<p align="center">
  <strong>An IDE for the terminal and AI.</strong><br />
  One window for your projects, AI agent terminals, live git changes and token usage.
</p>

<p align="center">
  <a href="https://github.com/JakubKonkol/Oxytocin/releases/latest"><img alt="Latest release" src="https://img.shields.io/badge/release-v0.9.0-orange" /></a>
  <a href="https://github.com/JakubKonkol/Oxytocin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JakubKonkol/Oxytocin/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" />
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img alt="Oxytocin: Claude Code working in a terminal, the project's live changes and usage on the left, a to-do list in the scratchpad on the right" src="docs/images/overview.png" width="960" />
</p>

## What is Oxytocin?

You run Claude Code in one terminal, Codex in another and a dev server in a third — across four projects. Which agent
is waiting for your answer? What did it just change? How much has it cost today?

**Oxytocin** is a desktop app built around that way of working. Your projects, agent terminals, the changes agents
make and what they cost live side by side in one window. Review a diff, fix a line, send a comment back to the agent
and commit — without switching tools. It does not try to replace your IDE: it is where you supervise the agents that
write the code.

<p align="center">
  <a href="https://github.com/JakubKonkol/Oxytocin/releases/latest"><strong>Download for Windows, macOS or Linux →</strong></a>
</p>

## Features

### 🧰 A modular workspace

Everything is a tab: terminals, diffs, files, tools and plugin panels. Split them, stack them, float them — or drag
any tool into the left or right sidebar to keep it next to you in every project. The **+** of each tab group opens a
new terminal (with any profile: a shell, Claude Code, Codex, …) or a tool: the scratchpad, the Run tool, the JSON
Formatter or a panel of your own plugin.

<p align="center">
  <img alt="Claude Code next to a dev server and a JSON Formatter, with the + menu listing terminals and tools" src="docs/images/modular-workspace.png" width="960" />
</p>

Every project keeps its own layout. Switching projects is instant and never stops a process; layouts and terminal
scrollback come back after a restart.

### 🖥️ Terminals built for AI agents

- **Agent detection** for Claude Code, Codex CLI, Gemini CLI, Aider and more: status dots show which agent is
  *working* and which is *waiting for you*, with notifications and `Ctrl+Shift+J` to jump straight to it.
- Fast terminals (node-pty + xterm.js, WebGL) with splits, search and shell integration — plus `Shift+Enter` for a
  newline in Claude Code, image pastes and clickable file paths.
- Offers to **resume agent sessions** after a restart.

### 🔍 Changes, review and git

- A live tree of every file changed since `HEAD`, and a diff that updates while the agent writes.
- **Git actions** in place: stage files or folders, discard, commit (*& Push*), amend, undo, pull, push, stash and
  branches.
- **Review** all changes on one page, mark files as viewed and leave comments — *Send comments* hands the whole review
  to the agent as one prompt.
- **Ask agent:** select code anywhere and press `Ctrl+L` — *Fix*, *Explain*, *Refactor*, *Add tests* or your own
  instruction goes to the agent together with the code.

### 📝 A built-in code editor

Browse the project in **FILES** and open files in a Monaco editor (the editor of VS Code) — for the moments when you
just want to read the code or fix one line. Files an agent is writing are never overwritten without asking. Prefer
your IDE? *Open in external editor* knows VS Code, Cursor, Windsurf, Zed, JetBrains IDEs and more.

### 🤖 Tools for your agents

Oxytocin is a local **MCP server** your agents connect to once (*Settings → Agent Tools*). Through it they read other
terminals' output, ask you questions, run your apps and query the project's **databases and APIs** (PostgreSQL,
SQL Server, MySQL, MongoDB, SQLite, Redis, HTTP APIs, …) — read-only by default, with credentials kept in your OS
keychain and never shown to the agent.

### 🎼 Ensemble: a team of agents on one task

Describe a task, pick a team — planner, implementer, reviewer, tester, researchers — and press *Start*. Agents
delegate to each other, you approve the plan at a gate, and the work happens in its own git worktree that you merge,
squash or discard at the end. A flow view shows who does what, and you can take over any agent's terminal.

### ▶️ Run your apps

The **Run** tool finds what a project can run — npm scripts, .NET, Django/FastAPI, Go, Rust, Spring Boot, Docker
Compose and more — and starts it with one click, with its status, URL and logs. Agents can start and restart your apps
too.

### 📊 Usage Monitor

Tokens and costs per session, project and model, read from your agents' **local logs**: daily charts, burn rate,
budgets with alerts and the real **5-hour and weekly limits** of a Claude Pro/Max plan. Nothing leaves your machine.

<p align="center">
  <img alt="Usage dashboard: daily cost over the last 30 days, tokens, projects and models" src="docs/images/usage-dashboard.png" width="960" />
</p>

### ⌨️ Keyboard first

A command palette, Quick Open for projects, terminals and files, an editable shortcut map, a settings UI, and dark,
light and system themes.

## Plugins

Oxytocin is extensible. A plugin is a folder with a `package.json` manifest, an optional **backend** (Node.js, with the
`oxy` API for projects, terminals, git, the UI and settings) and optional **views** (plain HTML, JS and CSS in
sandboxed iframes). Plugins add panels and tools, sidebar views, status bar items, commands, settings and terminal
profiles — and **tools that AI agents can call** through Oxytocin's MCP server.

For example, a status bar item that counts the terminals of the active project:

```jsonc
// package.json
"oxytocin": {
  "id": "acme.terminal-count",
  "displayName": "Terminal Count",
  "engine": "^0.1.6",
  "main": "dist/host.js",
  "activationEvents": ["onStartup"],
  "permissions": ["projects.read", "terminals.read-metadata"],
  "contributes": { "statusBarItems": [{ "id": "terminal-count.status" }] }
}
```

```ts
// src/host.ts
import type { PluginContext } from '@oxytocin/plugin-api';

export function activate({ oxy, subscriptions }: PluginContext): void {
  const item = oxy.ui.statusBarItem('terminal-count.status');
  const update = async () => {
    const project = await oxy.projects.getActive();
    const terminals = project ? await oxy.terminals.list({ projectId: project.id }) : [];
    item.text = `$(terminal) ${terminals.length}`;
    item.show();
  };
  subscriptions.push(
    item,
    oxy.terminals.onDidOpen(() => void update()),
    oxy.terminals.onDidClose(() => void update()),
    oxy.projects.onDidChangeActive(() => void update()),
  );
  void update();
}
```

A generator sets up a project with a backend, a view and a build; load it with **Plugins → Developer mode → Load
plugin from folder…** and share it as a `.zip` that anyone can install. The built-in plugins use the same public API:

| Built-in plugin | What it does |
|---|---|
| **Usage Monitor** | Token usage, costs, budgets and Claude subscription limits |
| **Project Runner** | Detects runnable apps, runs them with status, URLs and logs, and lets agents run them |
| **File Preview** | Live preview of Markdown (rendered) and code (highlighted) from terminal links |
| **Claude Code Bridge** | Exact Claude Code states (working, waiting for permission, finished) through hooks |
| **JSON Formatter** | Format, minify and validate JSON next to the terminal |

**→ [Plugin developer guide](docs/plugins/README.md)** — a step-by-step tutorial and the full API reference.

## Installation

Download the latest version from **[Releases](https://github.com/JakubKonkol/Oxytocin/releases/latest)**:

| Platform | Package |
|---|---|
| Windows 10/11 (primary platform) | `Oxytocin-Setup-x.y.z.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` / `.deb` |

**Requirements:** `git` 2.30 or newer on `PATH` for the git features.

> [!NOTE]
> The builds are not code-signed yet, so Windows SmartScreen ("More info → Run anyway") and macOS Gatekeeper warn on
> the first start. Installed apps update themselves from GitHub Releases.

## Getting started

1. **Add a project:** *Add project* (`Ctrl+Shift+A`) or drop a folder on the PROJECTS list. A terminal opens in it.
2. **Start an agent:** **+** → *Terminal profile* → Claude Code (or Codex, Gemini, …), or type `claude` in the
   terminal.
3. **Connect the agent tools** once: *Settings → Agent Tools → Connect Claude Code*.
4. **Follow the changes:** the CHANGES section fills while the agent works. Click a file for its diff, *Review all
   changes* when it is done, then commit.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+O` | Quick Open: projects, terminals and files |
| `Ctrl+Shift+J` | Jump to the agent that is waiting for you |
| `Ctrl+Shift+G` | Focus the CHANGES list |
| `Ctrl+L` | Ask an agent about the selected code |
| `Ctrl+,` | Settings |

On macOS most shortcuts use `Cmd`. Every shortcut can be changed in *Keyboard Shortcuts*.

## Development

Requires Node.js 24 (see `.nvmrc`) and npm 11.

```sh
npm install           # install dependencies (npm workspaces)
npm run dev           # run the app in development mode
npm run check         # typecheck + lint + unit/integration tests + license check
npm run e2e           # end-to-end tests (Playwright + Electron)
npm run package:win   # Windows installer into release/ (also package:mac, package:linux)
```

Oxytocin is an Electron app written in TypeScript and React. Terminals run in their own PTY Host process, file
watching and git in a Workspace Host and plugin backends in a Plugin Host, so a busy agent or a slow plugin never
blocks the UI.

```
src/main             Electron main process: windows, IPC and the utility hosts
src/pty-host         terminals (node-pty + headless xterm)
src/workspace-host   file watching, git and project files
src/plugin-host      plugin backends
src/connections-host database drivers and API requests for agents
src/renderer         React UI (dockview, xterm.js, Monaco)
src/shared           domain types, IPC/RPC contracts, zod schemas
packages/            plugin API types, view SDK and the plugin generator
plugins/             built-in plugins
```

More: [Plugin guide](docs/plugins/README.md) · [Releasing](docs/RELEASING.md) ·
[Testing the database bridge](docs/testing-databases.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 Jakub Konkol. Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
