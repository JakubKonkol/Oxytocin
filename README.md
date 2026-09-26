<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/brand/svg/logo-horizontal-on-dark.svg" />
    <img alt="Oxytocin" src="resources/brand/svg/logo-horizontal-on-light.svg" width="360" />
  </picture>
</p>

# Oxytocin

> **Status: work in progress.** Nothing here is ready for daily use yet.

Oxytocin is an "IDE for the terminal and AI": a desktop hub (Electron + TypeScript + React) for developers who
run AI coding agents (Claude Code, Codex CLI, Gemini CLI, Aider, …) in terminals. It is **not** a code editor —
keep using the editor you like. Oxytocin organizes everything around it:

- **Projects** with live activity indicators (agent working, waiting for you, process running, error) and instant
  switching that never kills your processes.
- **Terminals** (node-pty + xterm.js) with tabs, splits and drag and drop, AI agent detection and notifications.
- **Changes**: a live tree of files changed since `HEAD` with line counts and a read-only diff viewer.
- **Plugins** written in HTML/JS/CSS that dock into the sidebar, the center area and the status bar.
- **Usage Monitor**: tokens and USD cost per session, project and model, read from your agents' local logs.

## Requirements

- Windows 11 (primary platform); macOS and Linux are supported on a best-effort basis.
- Node.js 24 (see `.nvmrc`) and npm 11.
- `git` 2.30 or newer on `PATH`.

## Development

```sh
npm install        # install dependencies (npm workspaces)
npm run dev        # run the app in development mode
npm run build      # production build into out/
npm run check      # typecheck + lint + unit tests + license check
npm run e2e        # end-to-end tests (Playwright + Electron)
```

## Documentation

The implementation plan lives in [`docs/plan/`](docs/plan/README.md). Note: the plan documents are written in
Polish; everything else in this repository (code, UI, comments, commits) is in English.

## License

[MIT](LICENSE) © 2026 Jakub Konkol
