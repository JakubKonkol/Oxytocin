# Szablon `CLAUDE.md` (skopiuj do katalogu głównego repo w zadaniu M0-T9)

> Poniżej treść pliku — **po angielsku**, jak wszystko w repozytorium (ADR-018). Po skopiowaniu uzupełnij sekcję „Commands” o faktyczne skrypty z `package.json`.

---

```markdown
# Oxytocin — instructions for Claude Code

Oxytocin is a desktop hub (Electron 44 + TypeScript 6 + React 19) for developers who work with AI coding agents in the terminal:
projects with activity indicators, terminals (node-pty + xterm.js) with split views, a live git changes panel with diffs against HEAD (Monaco),
a web-based plugin engine (iframe views + Plugin Host) and a built-in Usage Monitor (agent token usage and costs).

## Read first
- `docs/plan/README.md` — plan index, verified facts, Definition of Done. (The plan documents are written in Polish.)
- `docs/plan/11-roadmap.md` — the next unchecked task + the implementation journal.
- The domain document referenced by the task (`docs/plan/0x-*.md`) and the ADRs in `docs/plan/12-decisions-risks.md`.

## Language and license
- **Everything in this repository is in English**: UI text, README, CHANGELOG, code comments, identifiers, log and error messages, test names, commit messages, spike reports, journal entries. No i18n framework. Polish UI texts and comments that appear in the plan describe intent only — use the English labels from `docs/plan/02-ui-ux.md` §13.
- **License: MIT.** Every `package.json` has `"license": "MIT"`. Only add dependencies with MIT-compatible licenses (`npm run licenses:check`). Files adapted from other projects (e.g. VS Code shell integration scripts) keep their original license header and source attribution.

## Commands
- `npm install` — install (npm workspaces; native modules come from prebuilt binaries only — do not run electron-rebuild).
- `npm run dev` — run the app in dev mode (renderer HMR; main/host changes restart the app).
- `npm run build` — build into `out/` (including built-in plugins).
- `npm run typecheck` · `npm run lint` · `npm test` · `npm run e2e` · `npm run check` (typecheck + lint + test + licenses).
- `npm run licenses:check` · `npm run licenses:notices` — license allowlist check and `THIRD_PARTY_NOTICES.md` generation.
- `npm run pricing:update` — refresh the Usage Monitor pricing snapshot.
- `npm run package:win` — Windows installer (electron-builder).

## Architecture (short)
- Processes: `src/main` (orchestrator) · `src/pty-host` (utilityProcess: node-pty + @xterm/headless) · `src/workspace-host` (utilityProcess: @parcel/watcher + git) · `src/plugin-host` (utilityProcess: plugin backends) · `src/renderer` (React UI) · `src/preload` (contextBridge `window.oxy`).
- `src/shared` — pure TS (domain types, IPC/RPC contracts, zod schemas). Never imports electron, DOM or Node-only APIs.
- Import boundaries are enforced by ESLint — do not work around them.
- Terminal data flows renderer ⇄ PTY Host over a MessagePort (sequence numbers + ACK flow control). Never through React/Zustand state.
- Plugins: `plugins/*` (built-in), API types in `packages/plugin-api`, view SDK in `packages/plugin-sdk`. Built-in plugins use the public API only.

## Code rules
- TypeScript strict, named exports, `Disposable` for subscriptions, zod at every IPC/RPC/file boundary.
- No synchronous I/O in the main process after startup. Heavy work goes to hosts / worker threads.
- Colors and sizes only via CSS tokens (`src/renderer/src/styles/tokens.css`).
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

## Session workflow
1. Pick the next task from `docs/plan/11-roadmap.md` (check its dependencies).
2. Implement it following the domain document; record deviations in the journal, and add a new ADR if a decision changes.
3. Run `npm run check` plus the relevant E2E tests.
4. Tick the checkbox and add an English entry to the implementation journal.
5. Commit using Conventional Commits (`feat(terminals): …`), **without** `Co-Authored-By` trailers or "Generated with Claude Code" footers. Do not push unless asked.
```
