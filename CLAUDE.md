# Oxytocin — instructions for Claude Code

Oxytocin is a desktop hub (Electron 44 + TypeScript 6 + React 19) for developers who work with AI coding agents in the terminal:
projects with activity indicators, terminals (node-pty + xterm.js) with split views, a live git changes panel with diffs against HEAD (Monaco),
a web-based plugin engine (iframe views + Plugin Host) and a built-in Usage Monitor (agent token usage and costs).

## Owner's working rules (mandatory in every session)
1. **Work directly on `main`.**
2. **Commit only a working state:** `npm run check` green, the relevant E2E tests green, the app builds and starts.
3. **Record user-visible changes** in the `## [Unreleased]` section of `CHANGELOG.md`, then commit and **push**
   (`git push origin main`).
4. **Never wire unfinished features into the visible UI.** Keep unfinished parts unwired or behind the
   `OXYTOCIN_EXPERIMENTAL=1` environment flag.
5. Commits: Conventional Commits (`feat(terminals): …`, `fix(git): …`), authored as the repository owner
   (`git config user.name "Jakub Konkol"`, `git config user.email "jakub.konkol27@gmail.com"`), **without**
   `Co-Authored-By` trailers or "Generated with Claude Code" footers.
6. Releases: see `docs/RELEASING.md` (bump `version`, move the changelog section, tag `vX.Y.Z`).

## Language and license
- **Everything in this repository is in English**: UI text, README, CHANGELOG, code comments, identifiers, log and error messages, test names, commit messages, docs. No i18n framework.
- **License: MIT.** Every `package.json` has `"license": "MIT"`. Only add dependencies with MIT-compatible licenses (`npm run licenses:check`). Files adapted from other projects (e.g. VS Code shell integration scripts) keep their original license header and source attribution.

## Commands
- `npm install` — install (npm workspaces; native modules come from prebuilt binaries — node-pty compiles from source on Linux; do not run electron-rebuild). npm 11 only runs install scripts of packages listed in `allowScripts` in `package.json`; approve new ones with `npm install-scripts approve <pkg>`.
- `npm run dev` — run the app in dev mode (renderer HMR; main/host changes restart the app).
- `npm run build` — build into `out/`.
- `npm run typecheck` · `npm run lint` (ESLint + Prettier check) · `npm run format` · `npm test` (Vitest projects `unit-node` + `unit-web`, then `integration` on its own like CI — its timing tests are flaky under parallel load) · `npm run e2e` (builds, then Playwright + Electron) · `npm run check` (typecheck + lint + test + licenses).
- `npm run licenses:check` · `npm run licenses:notices` — license allowlist check and `THIRD_PARTY_NOTICES.md` generation (run it after adding production dependencies).
- `npm run pricing:update` — refresh the Usage Monitor pricing snapshot (M6).
- `npm run package:win` — Windows installer (electron-builder, M5/M6).

## Environment notes (Linux containers / cloud sessions)
- Run E2E under a virtual display: `xvfb-run -a npm run e2e`. The E2E launcher passes `--no-sandbox` on Linux (root/CI).
- Running Electron manually as root requires `--no-sandbox` (e.g. `npx electron-vite dev --noSandbox`).
- If Electron's binary download fails behind the sandbox proxy (undici assertion), download
  `electron-v<version>-linux-x64.zip` with curl into `~/.cache/electron/<sha256 of the release URL dir>/` and run
  `node node_modules/electron/install.js`.
- Node 24 is required (`.nvmrc`); install it if the image only has an older Node.

## Architecture (short)
- Processes: `src/main` (orchestrator) · `src/pty-host` (utilityProcess: node-pty + @xterm/headless) · `src/workspace-host` (utilityProcess: @parcel/watcher + git) · `src/plugin-host` (utilityProcess: plugin backends) · `src/renderer` (React UI) · `src/preload` (contextBridge `window.oxy`).
- `src/shared` — pure TS (domain types, IPC/RPC contracts, zod schemas). Never imports electron, DOM or Node-only APIs.
- IPC: channel names in `src/shared/ipc/channels.ts`, zod contracts in `contract.ts`/`events.ts`, handlers registered through `src/main/ipc/router.ts` (sender check + validation). Main ⇄ hosts use `createPortRpc` (`src/shared/rpc`), supervised by `UtilityHost` (restart + health checks).
- Import boundaries are enforced by ESLint — do not work around them.
- Terminal data flows renderer ⇄ PTY Host over a MessagePort (sequence numbers + ACK flow control). Never through React/Zustand state.
- Plugins: `plugins/*` (built-in), API types in `packages/plugin-api`, view SDK in `packages/plugin-sdk`. Built-in plugins use the public API only.
- Test-only hooks exist only with `OXYTOCIN_E2E=1` (`globalThis.__oxyMain` in main, `window.__oxyTest` in the renderer).

## Code rules
- TypeScript strict, named exports, `Disposable` for subscriptions, zod at every IPC/RPC/file boundary.
- No synchronous I/O in the main process after startup. Heavy work goes to hosts / worker threads.
- Colors and sizes only via CSS tokens (`src/renderer/src/styles/tokens.css`); Tailwind utilities map to them (`bg-card`, `text-fg-muted`, `border-line`…).
- Every behavior change gets a test (unit/integration) plus an E2E test for user-visible features.
- Primary platform: Windows 11. Platform-specific code lives in `*.win.ts` / `*.posix.ts`.

## Pitfalls (verified during research)
- electron-vite 5 supports Vite ≤ 7 only; typescript-eslint requires TS < 6.1 — check peer deps before bumping.
- TS 6.0: set `types` explicitly in every tsconfig.
- node-pty 1.1.0: prebuilt for Windows/macOS, use `useConptyDll: true`; `asarUnpack` it when packaging; on macOS `spawn-helper` needs `chmod +x`.
- Always run git with `--no-optional-locks` (otherwise `index.lock` collides with the agent); read HEAD content via `git cat-file --filters` (CRLF correctness).
- dockview: panels hosting iframes and terminals must use `renderer: 'always'`; iframes get `pointer-events: none` during drag and drop.
- Shift+Enter in the terminal → `\x1b\r` (newline in Claude Code); plain Ctrl+<letter> shortcuts belong to the shell/agent.
- When Oxytocin is started from a Claude Code session it inherits `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` etc. — the env composer must strip them for terminals (otherwise `claude` inside a terminal thinks it is nested).
- `File.path` does not exist in Electron ≥ 32 — get drag-and-drop paths via `webUtils.getPathForFile` in the preload.
- Node's `URL` gives custom schemes like `app://` an opaque origin (`"null"`) — compare protocol and host instead of `origin`.
- `SerializeAddon` does not serialize cursor visibility (`?25l`) or the SGR mouse encoding (`?1006h`); the headless mirror appends them.

## Session workflow
1. Implement the change; add a test (unit/integration) and an E2E test for user-visible features.
2. Run `npm run check` plus the relevant E2E tests (`xvfb-run -a npm run e2e` on Linux).
3. Update `CHANGELOG.md`, commit (Conventional Commits, no trailers) and push to `main`.
