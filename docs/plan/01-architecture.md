# 01 — Architektura techniczna

## 1. Stack technologiczny

| Obszar | Wybór | Wersja (pin `~`) | Uzasadnienie / uwagi |
|---|---|---|---|
| Runtime | Electron | `~44.4.5` | Najnowszy stable (Node 24.21, Chromium 152). Upgrade do 45 po wydaniu (2026-10-20) jako osobne zadanie. |
| Język | TypeScript | `~6.0.3` | Ograniczenie typescript-eslint (`<6.1`). **Uwaga TS 6.0:** jawnie ustaw `"types": [...]` w każdym tsconfig (nie polegaj na automatycznym dołączaniu `@types/*`), `strict: true`, `module`/`moduleResolution: "bundler"` dla renderera i `"nodenext"`-kompatybilne ustawienia dla procesów Node wg potrzeb electron-vite. Zweryfikuj zmiany domyślnych opcji TS 6 w M0. |
| Build | electron-vite | `~5.0.0` + `vite ~7.3` | Jeden config dla main/preload/renderer; wiele wejść main (utility processes). |
| Pakowanie | electron-builder | `~26.15` | NSIS/dmg/AppImage/deb, `asarUnpack` dla modułów natywnych, fuses. |
| UI | React 19 + react-dom | `~19.3` | |
| Stan UI | Zustand | `~5.0` | Lekki, poza drzewem React (ważne dla xterm i zdarzeń IPC). |
| Walidacja | zod | `~4.6` | Kontrakty IPC, manifest wtyczek, ustawienia, pliki stanu. |
| Style | Tailwind CSS v4 + CSS variables | `~4.3` | Tokeny w CSS vars (współdzielone z dockview, xterm, Monaco i wtyczkami). |
| Prymitywy UI | `radix-ui` | `~1.6` | ContextMenu, DropdownMenu, Dialog, Tooltip, ScrollArea. |
| Ikony | `lucide-react` + `@vscode/codicons` | | lucide dla UI, codicons dla typów plików/akcji IDE-like. |
| Layout centralny | `dockview-react` | `~8.3.1` | Taby, podziały, DnD, floating, serializacja; Paneview dla sidebara. |
| Terminal (UI) | `@xterm/xterm` + addony | `~6.0.0` | Renderer DOM domyślnie, WebGL opcjonalnie. |
| Terminal (backend) | `node-pty` | `~1.1.0` | Prebuildy Windows/macOS; `useConptyDll`. |
| Lustro bufora | `@xterm/headless` + `@xterm/addon-serialize` | `~6.0.0` / `~0.14` | Snapshot do rehydratacji i persystencji. |
| Drzewo procesów | `@vscode/windows-process-tree` (Win), `ps` (POSIX) | `~0.8.0` | Wykrywanie agentów i „busy”. |
| Watcher FS | `@parcel/watcher` | `~2.6.0` | Natywny, wydajny, ignorowanie ścieżek. |
| Git | systemowy `git` (CLI) | ≥ 2.30 | `--no-optional-locks`, porcelain v2. |
| Diff viewer | `monaco-editor` + `@monaco-editor/react` | `~0.57` / `~4.7` | Tylko DiffEditor read-only, lokalny bundle (bez CDN). |
| Baza danych | `node:sqlite` (wbudowane) | Node 24 | Sprawdzone w Electron 44. Fallback: `better-sqlite3 ~13`. |
| Paleta | `cmdk` | `~1.1` | |
| Wirtualizacja | `@tanstack/react-virtual` | `~3.14` | Drzewo zmian, listy sesji. |
| Toasty | `sonner` | `~2.0` | |
| Język UI | angielski, **bez frameworka i18n** | — | ADR-018: UI, README, komentarze, logi, commity po angielsku. |
| Licencja | MIT | — | ADR-020: `LICENSE`, `"license": "MIT"`, `THIRD_PARTY_NOTICES.md`, kontrola licencji zależności w CI. |
| Logi | `electron-log` | `~5.4` | Wszystkie procesy, rotacja. |
| Testy | Vitest 5, Testing Library, Playwright 1.63 | | Unit/integration + E2E `_electron`. |
| Lint/format | ESLint 10 (flat) + typescript-eslint 8.70 + eslint-plugin-react-hooks 7 + Prettier 3.9 | | |
| Menedżer pakietów | **npm workspaces** (npm 11) | | Brak pnpm na maszynie; npm najprostszy z electron-builder i modułami natywnymi. |
| Node (dev/CI) | 24.x (`.nvmrc`) | | Zgodny z Node w Electron 44. |

**Polityka wersji:** zależności przypięte tyldą (`~`), `package-lock.json` w repo, Renovate/Dependabot opcjonalnie później. Moduły natywne wyłącznie z prebuildami (brak VS Build Tools na maszynie deweloperskiej).

## 2. Model procesów

```
┌──────────────────────────────── Oxytocin (Electron) ─────────────────────────────────┐
│                                                                                       │
│  MAIN PROCESS (orkiestrator, lekki, nigdy nie robi ciężkiej pracy synchronicznie)     │
│   AppLifecycle · WindowManager · ProtocolService (app://, oxy-plugin://)              │
│   SettingsService · ProjectService · WorkspaceStateService · ShellEnvService          │
│   TerminalService (proxy) · AgentService · GitService (proxy) · PluginService         │
│   NotificationService · EditorLauncher · IpcRouter                                    │
│        │ parentPort RPC            │ parentPort RPC              │ parentPort RPC      │
│  ┌─────▼───────────────┐   ┌───────▼──────────────┐   ┌──────────▼───────────────┐    │
│  │ PTY HOST            │   │ WORKSPACE HOST       │   │ PLUGIN HOST              │    │
│  │ (utilityProcess)    │   │ (utilityProcess)     │   │ (utilityProcess)         │    │
│  │ node-pty (ConPTY)   │   │ @parcel/watcher      │   │ backendy wtyczek (Node)  │    │
│  │ @xterm/headless ×N  │   │ git CLI (spawn)      │   │ usage-monitor, md-preview│    │
│  │ ProcessMonitor      │   │ status/diff/numstat  │   │ node:sqlite, http (OTLP) │    │
│  │ OSC handlers        │   │                      │   │                          │    │
│  └─────▲───────────────┘   └──────────────────────┘   └──────────────────────────┘    │
│        │ MessagePort (I/O terminali — bezpośrednio, bez main)                          │
│  ┌─────▼─────────────────────────────────────────────────────────────────────────┐    │
│  │ RENDERER (UI powłoki, React)          app://oxytocin/index.html               │    │
│  │  TitleBar · Sidebar(Paneview) · Center(Dockview per projekt) · StatusBar      │    │
│  │  xterm.js · Monaco DiffEditor · <iframe src="oxy-plugin://<id>/view.html">    │    │
│  └───────────────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Odpowiedzialności i powody podziału

| Proces | Odpowiada za | Dlaczego osobno |
|---|---|---|
| **Main** | Cykl życia, okna, menu, protokoły, stan domenowy (projekty, rejestr terminali, ustawienia), routing IPC, powiadomienia OS, `shell.*` (openExternal, trashItem). | Musi być zawsze responsywny — blokada main zamraża całe UI i IPC. |
| **PTY Host** | Tworzenie/zabijanie PTY, lustro bufora (headless), serializacja, flow control, monitor procesów, parsowanie OSC (tytuł, BEL, progress, notyfikacje). | Kod natywny (node-pty) + duża przepustowość danych; crash nie może zabić main. Wzorzec VS Code („pty host”). |
| **Workspace Host** | Watchery FS dla projektów, uruchamianie git, parsowanie wyników, liczenie linii, pobieranie treści do diffu. | Burze zdarzeń FS (npm install) i parsowanie dużych wyjść git nie mogą obciążać main ani PTY Host. |
| **Plugin Host** | Ładowanie i aktywacja backendów wtyczek, implementacja API `oxy.*` po stronie wtyczki. | Izolacja błędów wtyczek (pętle, wyjątki, wycieki) od rdzenia; możliwość restartu. |
| **Renderer** | Całe UI powłoki; widoki wtyczek w iframe (inny origin → osobny proces renderera dzięki site isolation, gdy Chromium go wydzieli). | Standard Electron; brak Node w rendererze (sandbox). |

### 2.2 Tworzenie utility processes

- API: `utilityProcess.fork(modulePath, args, { serviceName, stdio: 'pipe', env })`. `serviceName`: `Oxytocin PTY Host`, `Oxytocin Workspace Host`, `Oxytocin Plugin Host` (widoczne w Menedżerze zadań).
- Wejścia budowane przez electron-vite jako **dodatkowe `rollupOptions.input` w sekcji `main`** (np. `ptyHost: 'src/pty-host/index.ts'`) — ścieżka wynikowa `out/main/ptyHost.js`, rozwiązywana w runtime przez `path.join(__dirname, 'ptyHost.js')`. (Alternatywa `?modulePath` ma znany problem z aliasami — issue electron-vite #851 — więc jej nie używamy.)
- W trybie dev: `execArgv: ['--inspect=9230' | 9231 | 9232]` gdy `OXYTOCIN_INSPECT_HOSTS=1`.
- `stdout/stderr` hostów przekierowane do electron-log main z prefiksem procesu.
- **Polityka restartu** (`src/main/hosts/utility-host.ts`): przy nieoczekiwanym `exit` — restart z backoffem 0.5 s → 2 s → 5 s, maks. 3 restarty / 5 min, potem stan `failed` i komunikat w UI. Każdy host eksportuje `ping()` (health check co 10 s, timeout 3 s → log ostrzeżenia; 3× z rzędu → kill + restart).
- Skutki crashu: **PTY Host** — procesy terminali giną razem z nim (ConPTY/PTY zamyka się); UI pokazuje panele jako „Disconnected — the PTY host crashed” z przyciskiem „Restart terminal” (respawn z tym samym profilem/cwd). **Workspace Host** — bezstanowy: restart + ponowne subskrypcje watcherów. **Plugin Host** — restart + ponowna aktywacja; widoki pokazują placeholder „Plugin is restarting…”.

## 3. Struktura repozytorium

Katalog główny repozytorium = aplikacja Electron (nie jest pakietem workspace), co upraszcza electron-builder. Pakiety pomocnicze i wtyczki wbudowane są workspace'ami npm.

```
oxytocin/
├─ package.json                 # app; "workspaces": ["packages/*", "plugins/*"]
├─ package-lock.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json                # references
├─ tsconfig.node.json           # main, preload, hosts, shared
├─ tsconfig.web.json            # renderer, shared
├─ eslint.config.js · .prettierrc · .editorconfig · .nvmrc · .gitignore
├─ LICENSE                      # MIT (ADR-020)
├─ THIRD_PARTY_NOTICES.md       # generowany: scripts/generate-notices.ts
├─ README.md                    # po angielsku
├─ CLAUDE.md                    # z docs/plan/claude-md-template.md
├─ resources/                   # ikony aplikacji, shell-integration scripts, fonts (jeśli nie w rendererze)
├─ scripts/
│  ├─ update-pricing.ts         # generuje snapshot cennika dla usage-monitor
│  ├─ build-plugins.ts          # buduje plugins/* do plugins/*/dist
│  ├─ generate-notices.ts       # THIRD_PARTY_NOTICES.md z licencji zależności produkcyjnych
│  └─ make-fixtures.ts          # (opcjonalnie) generator fixture'ów
├─ src/
│  ├─ shared/                   # czysty TS: bez 'electron', bez DOM, bez Node-only API (poza typami)
│  │  ├─ domain/                # project.ts, terminal.ts, agent.ts, git.ts, settings.ts, plugin.ts, usage.ts
│  │  ├─ ipc/                   # contract.ts (invoke), events.ts (push), channels.ts
│  │  ├─ rpc/                   # port-rpc.ts (request/response + events nad MessagePort/parentPort)
│  │  ├─ schemas/               # zod dla domeny (re-export)
│  │  └─ utils/                 # disposable.ts, emitter.ts, debounce.ts, paths.ts, result.ts, ids.ts, lru.ts
│  ├─ main/
│  │  ├─ index.ts               # bootstrap (kolejność startu — §6)
│  │  ├─ app/                   # lifecycle.ts, single-instance.ts, window-manager.ts, menu.ts,
│  │  │                         # protocols.ts, security.ts, paths.ts, quit-guard.ts
│  │  ├─ ipc/                   # router.ts, handlers/{projects,terminals,git,settings,plugins,app}.ts
│  │  ├─ hosts/                 # utility-host.ts, pty-host-client.ts, workspace-host-client.ts, plugin-host-client.ts
│  │  └─ services/
│  │     ├─ settings/           # settings-service.ts, schema.ts, jsonc-store.ts, migrations.ts
│  │     ├─ projects/           # project-service.ts, project-store.ts
│  │     ├─ workspace-state/    # workspace-state-service.ts (layout + deskryptory paneli + scrollback)
│  │     ├─ terminals/          # terminal-service.ts, profiles.ts, env-composer.ts, shell-detect/{win,posix}.ts
│  │     ├─ agents/             # agent-service.ts, rules.ts, claude-registry.ts, activity.ts
│  │     ├─ git/                # git-service.ts (proxy + cache + zdarzenia)
│  │     ├─ plugins/            # plugin-service.ts, manifest.ts, discovery.ts, view-router.ts, env-collection.ts
│  │     ├─ notifications/      # notification-service.ts (OS + in-app + taskbar)
│  │     ├─ shell-env/          # resolve-shell-env.ts (macOS/Linux)
│  │     └─ editor/             # editor-launcher.ts (presety edytorów)
│  ├─ preload/
│  │  └─ index.ts               # contextBridge: window.oxy (invoke/on/ports/webUtils)
│  ├─ pty-host/
│  │  ├─ index.ts               # parentPort RPC server, rejestr sesji, porty rendererów
│  │  ├─ terminal-session.ts    # node-pty + headless + seq + batching + flow control
│  │  ├─ headless-mirror.ts
│  │  ├─ flow-control.ts
│  │  ├─ data-batcher.ts
│  │  ├─ osc-handlers.ts        # tytuł (0/2), BEL, OSC 9 / 9;4 / 777 / 7 / 633
│  │  └─ process-monitor/       # index.ts, windows.ts, posix.ts
│  ├─ workspace-host/
│  │  ├─ index.ts
│  │  ├─ repo-watcher.ts
│  │  ├─ refresh-scheduler.ts
│  │  └─ git/                   # exec.ts, discover.ts, porcelain-v2.ts, numstat.ts, status.ts, diff-content.ts, actions.ts
│  ├─ plugin-host/
│  │  ├─ index.ts
│  │  ├─ loader.ts · activation.ts · registry.ts
│  │  └─ api/                   # create-api.ts, projects.ts, terminals.ts, agents.ts, git.ts, ui.ts,
│  │                            # commands.ts, settings.ts, storage.ts, log.ts, permissions.ts
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx · App.tsx · providers.tsx
│        ├─ shell/              # TitleBar, Sidebar, StatusBar, WorkspaceHost, AppLayout
│        ├─ features/
│        │  ├─ projects/        # ProjectsSection, ProjectItem, AddProjectDialog, store.ts
│        │  ├─ changes/         # ChangesSection, ChangeTree, ChangesHeader, store.ts, tree-model.ts
│        │  ├─ diff/            # DiffPanel, monaco-setup.ts, monaco-theme.ts
│        │  ├─ terminals/       # TerminalPanel, TerminalView, xterm-factory.ts, key-handler.ts,
│        │  │                   # link-providers.ts, pty-channel.ts, terminal-registry.ts, find-widget
│        │  ├─ layout/          # ProjectWorkspace, dockview-config.ts, panel-registry.ts, tabs/, persistence.ts
│        │  ├─ plugins/         # PluginFrame (iframe), PluginPanel, PluginSidebarPane, StatusBarItems, view-bridge.ts
│        │  ├─ palette/         # CommandPalette, QuickOpen (M7)
│        │  ├─ settings/        # SettingsPanel (M7), plugin manager
│        │  └─ notifications/
│        ├─ lib/                # ipc-client.ts, commands.ts, keybindings.ts, messages.ts (angielskie komunikaty błędów), theme.ts, focus.ts
│        ├─ ui/                 # prymitywy (Button, IconButton, Badge, StatusDot, Section, Tree, Kbd, Progress…)
│        └─ styles/             # tokens.css, globals.css, dockview.css, xterm.css, monaco.css
├─ packages/
│  ├─ plugin-api/               # @oxytocin/plugin-api — publiczne typy (d.ts) API backendu wtyczek
│  └─ plugin-sdk/               # @oxytocin/plugin-sdk — runtime widoków (connect(), theme.css)
├─ plugins/
│  ├─ usage-monitor/            # wbudowana wtyczka (host + views)
│  └─ markdown-preview/         # wbudowana wtyczka
├─ tests/
│  ├─ e2e/                      # Playwright specs + helpers (launchApp, tmp userData, tmp repo)
│  └─ fixtures/                 # claude/, codex/, gemini/ (zanonimizowane JSONL), repos/
└─ docs/
   ├─ plan/                     # ten plan
   └─ spikes/                   # wyniki spike'ów S1–S8 (tworzone w trakcie)
```

**Reguły zależności między katalogami** (egzekwowane ESLint `no-restricted-imports`):
- `shared/` nie importuje niczego spoza `shared/`.
- `renderer/` importuje tylko `shared/` i własne moduły (nigdy `electron`, `node:*`).
- `pty-host/`, `workspace-host/`, `plugin-host/` importują `shared/` i swoje moduły; nie importują `main/`.
- `main/` nie importuje kodu hostów (komunikacja wyłącznie przez RPC).
- `plugins/*` importują wyłącznie `@oxytocin/plugin-api` (typy) i `@oxytocin/plugin-sdk`.

## 4. Komunikacja (IPC)

Trzy rodzaje kanałów:

| Rodzaj | Mechanizm | Użycie |
|---|---|---|
| **Invoke** (request/response) | `ipcRenderer.invoke` ↔ `ipcMain.handle` | Operacje domenowe: `projects:add`, `terminals:create`, `git:getFileDiff`, … |
| **Events** (push main → renderer) | `webContents.send` → `ipcRenderer.on` | Zmiany stanu: `projects:changed`, `terminals:updated`, `git:status`, `agents:updated`, … |
| **Porty** (strumienie) | `MessageChannelMain` → `MessagePort` | I/O terminali (renderer ⇄ PTY Host), bezpośrednio z pominięciem main. |

Main ⇄ hosty: `process.parentPort` / `child.postMessage` opakowane w **`createPortRpc`** (wspólne dla wszystkich par).

### 4.1 Kontrakt (źródło prawdy typów)

```ts
// src/shared/ipc/contract.ts
import { z } from 'zod';
import * as S from '../schemas';

export const invokeContract = {
  'app:getInfo':            { req: z.void(), res: S.AppInfo },
  'settings:get':           { req: z.void(), res: S.Settings },
  'settings:update':        { req: S.SettingsPatch, res: S.Settings },
  'projects:list':          { req: z.void(), res: z.array(S.Project) },
  'projects:add':           { req: z.object({ path: z.string().min(1) }), res: S.Project },
  'projects:remove':        { req: z.object({ id: S.ProjectId, killTerminals: z.boolean() }), res: z.void() },
  'projects:update':        { req: S.ProjectPatch, res: S.Project },
  'projects:reorder':       { req: z.object({ ids: z.array(S.ProjectId) }), res: z.void() },
  'projects:setActive':     { req: z.object({ id: S.ProjectId }), res: z.void() },
  'projects:pickFolder':    { req: z.void(), res: z.string().nullable() },
  'workspace:load':         { req: z.object({ projectId: S.ProjectId }), res: S.WorkspaceState.nullable() },
  'workspace:save':         { req: S.WorkspaceState, res: z.void() },
  'terminals:create':       { req: S.CreateTerminalRequest, res: S.TerminalInfo },
  'terminals:kill':         { req: z.object({ id: S.TerminalId, force: z.boolean().optional() }), res: z.void() },
  'terminals:restart':      { req: z.object({ id: S.TerminalId }), res: S.TerminalInfo },
  'terminals:rename':       { req: z.object({ id: S.TerminalId, title: z.string().max(80) }), res: z.void() },
  'terminals:list':         { req: z.object({ projectId: S.ProjectId.optional() }), res: z.array(S.TerminalInfo) },
  'terminals:profiles':     { req: z.void(), res: z.array(S.TerminalProfile) },
  'git:getStatus':          { req: z.object({ projectId: S.ProjectId }), res: S.RepoStatus.nullable() },
  'git:getFileDiff':        { req: z.object({ projectId: S.ProjectId, path: z.string(), oldPath: z.string().optional() }), res: S.FileDiffContent },
  'git:refresh':            { req: z.object({ projectId: S.ProjectId }), res: z.void() },
  'fs:statMany':            { req: z.object({ baseDirs: z.array(z.string()).max(4), paths: z.array(z.string()).max(50) }),
                              res: z.array(z.object({ path: z.string(), resolved: z.string().nullable(), isFile: z.boolean() })) },  // linki plików w terminalu
  'clipboard:read':         { req: z.void(), res: z.object({ text: z.string(), hasImage: z.boolean() }) },  // moduł clipboard w main — renderer nie potrzebuje uprawnienia clipboard-read
  'clipboard:writeText':    { req: z.object({ text: z.string().max(10_000_000) }), res: z.void() },
  'shell:openExternal':     { req: z.object({ url: z.string().url() }), res: z.void() },
  'shell:revealInFolder':   { req: z.object({ path: z.string() }), res: z.void() },
  'editor:open':            { req: z.object({ path: z.string(), line: z.number().int().optional(), column: z.number().int().optional() }), res: z.void() },
  'plugins:list':           { req: z.void(), res: z.array(S.PluginDescriptor) },
  'plugins:setEnabled':     { req: z.object({ id: z.string(), enabled: z.boolean() }), res: z.void() },
  'plugins:viewMessage':    { req: S.ViewMessageEnvelope, res: z.unknown() },
  'commands:execute':       { req: z.object({ id: z.string(), args: z.array(z.unknown()).default([]) }), res: z.unknown() },
  // … rozszerzane w kolejnych kamieniach
} as const;

export type InvokeChannel = keyof typeof invokeContract;
export type InvokeReq<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['req']>;
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['res']>;
```

```ts
// src/shared/ipc/events.ts
export const eventContract = {
  'projects:changed':   z.array(S.Project),
  'projects:active':    z.object({ id: S.ProjectId.nullable() }),
  'projects:activity':  z.record(S.ProjectId, S.ProjectActivity),
  'terminals:updated':  S.TerminalInfo,
  'terminals:removed':  z.object({ id: S.TerminalId }),
  'agents:updated':     z.array(S.AgentInfoWithTerminal),
  'git:status':         S.RepoStatus,
  'git:fileTouched':    z.object({ projectId: S.ProjectId, paths: z.array(z.string()), at: z.number() }),
  'settings:changed':   S.Settings,
  'plugins:changed':    z.array(S.PluginDescriptor),
  'plugins:contributions': S.ContributionsSnapshot,
  'plugins:viewMessage':   S.ViewMessageEnvelope,
  'notifications:show': S.InAppNotification,
  'commands:run':       z.object({ id: z.string(), args: z.array(z.unknown()) }), // z menu natywnego
} as const;
```

### 4.2 Router w main

```ts
// src/main/ipc/router.ts (szkic)
type Handler<C extends InvokeChannel> =
  (req: z.output<(typeof invokeContract)[C]['req']>, ctx: IpcContext) => Promise<InvokeRes<C>> | InvokeRes<C>;

export function registerInvokeHandlers(handlers: { [C in InvokeChannel]?: Handler<C> }) {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);                      // senderFrame.url musi być app:// (prod) lub dev server (dev), top-level frame
      const spec = invokeContract[channel as InvokeChannel];
      const req = spec.req.parse(raw);                 // ZodError → serializowany błąd walidacji
      try { return await handler(req, { webContents: event.sender }); }
      catch (e) { throw toIpcError(e); }               // { code, message, details } — bez stack trace do renderera w prod
    });
  }
}
```

Błędy: `class OxyError extends Error { code: 'NOT_FOUND' | 'INVALID' | 'GIT_NOT_FOUND' | 'NOT_A_REPO' | 'SPAWN_FAILED' | 'PERMISSION' | 'INTERNAL'; details? }`. Renderer mapuje `code` na angielskie komunikaty dla użytkownika (`lib/messages.ts`).

### 4.3 Preload

```ts
// src/preload/index.ts (szkic)
const api = {
  invoke: (channel: string, payload?: unknown) => {
    if (!INVOKE_CHANNELS.has(channel)) throw new Error(`Blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  on: (event: string, cb: (payload: unknown) => void) => {
    if (!EVENT_CHANNELS.has(event)) throw new Error(`Blocked event ${event}`);
    const l = (_: unknown, p: unknown) => cb(p);
    ipcRenderer.on(event, l);
    return () => ipcRenderer.removeListener(event, l);
  },
  getPathForFile: (f: File) => webUtils.getPathForFile(f),   // DnD folderów/plików (File.path nie istnieje od Electron 32)
  platform: process.platform,
};
contextBridge.exposeInMainWorld('oxy', api);

// Port PTY: main wysyła port do preload; preload przekazuje go do main world (wzorzec z dokumentacji Electron „MessagePorts”)
ipcRenderer.on('pty:port', (e) => window.postMessage({ type: 'oxy:pty-port' }, '*', [e.ports[0]]));
```

Renderer ma typowany klient `ipc.invoke('projects:add', { path })` / `ipc.on('git:status', cb)` generowany z kontraktu (`src/renderer/src/lib/ipc-client.ts`). Renderer **nie waliduje** odpowiedzi z main (zaufane), ale waliduje wiadomości z iframe'ów wtyczek.

### 4.4 `createPortRpc` (main ⇄ hosty)

```ts
// src/shared/rpc/port-rpc.ts
export interface RpcEndpoint { postMessage(msg: unknown, transfer?: unknown[]): void; on(cb: (msg: unknown, ports?: unknown[]) => void): Disposable }
type Wire =
  | { k: 'req'; id: number; m: string; p: unknown }
  | { k: 'res'; id: number; ok: true; r: unknown } | { k: 'res'; id: number; ok: false; e: { code: string; message: string } }
  | { k: 'evt'; n: string; p: unknown };

export function createPortRpc<Methods, Events>(ep: RpcEndpoint, impl?: Partial<Methods>) {
  // call<M>(method, params, { timeoutMs = 15_000 }) → Promise
  // emit<E>(name, payload)
  // onEvent<E>(name, cb) → Disposable
  // serve: dla przychodzących 'req' wywołuje impl[m](p) i odsyła 'res'
}
```

Adaptery: `fromParentPort(process.parentPort)` (w hoście), `fromUtilityProcess(child)` (w main), `fromMessagePort(port)` (renderer ↔ PTY Host). Kontrakty metod/zdarzeń każdego hosta w `src/shared/rpc/contracts/{pty-host,workspace-host,plugin-host}.ts`.

### 4.5 Kanał I/O terminali

1. Po utworzeniu okna i startu PTY Host main tworzy `MessageChannelMain`: `port1 → ptyHost.postMessage({ t: 'renderer-port', windowId }, [port1])`, `port2 → win.webContents.postMessage('pty:port', null, [port2])`.
2. Po reloadzie renderera (`did-finish-load` po raz kolejny) procedura jest powtarzana; PTY Host zamyka stary port (zdarzenie `close`) i porzuca jego subskrypcje.
3. Protokół wiadomości opisany w [04-terminals.md §4](04-terminals.md).

## 5. Bezpieczeństwo (checklista obowiązkowa od M0)

- `BrowserWindow.webPreferences`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`, `spellcheck: false`, `preload` tylko dla głównego okna.
- Produkcja: renderer ładowany z **`app://oxytocin/index.html`** (`protocol.handle('app', …)` serwujący `out/renderer` z kontrolą path traversal), nie `file://`. Dev: URL serwera Vite.
- `protocol.registerSchemesAsPrivileged` (przed `ready`): `app` i `oxy-plugin` z `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }`.
- CSP powłoki (nagłówek z handlera `app://` + meta w dev):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: oxy-plugin:; font-src 'self' data:; frame-src oxy-plugin:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`
  (W dev dodaj `ws://localhost:*` i `http://localhost:*` dla HMR.)
- `webContents.on('will-navigate')` → blokada wszystkiego poza własnym originem; `setWindowOpenHandler` → `deny` + `shell.openExternal` tylko dla `http:`/`https:`/`mailto:` po walidacji.
- `session.setPermissionRequestHandler` i `setPermissionCheckHandler` → odmowa wszystkiego poza `clipboard-sanitized-write`; odczyt schowka wyłącznie przez IPC `clipboard:read` (main).
- `assertTrustedSender`: każdy handler IPC sprawdza `event.senderFrame` (top frame, origin `app://oxytocin` lub dev URL). Iframe'y wtyczek nie mają preloadu ani dostępu do `window.oxy`.
- **Electron Fuses** (w `afterPack`): `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`, `EnableNodeCliInspectArguments=false`, `EnableEmbeddedAsarIntegrityValidation=true`, `OnlyLoadAppFromAsar=true`, `EnableCookieEncryption=true`, `GrantFileProtocolExtraPrivileges=false`.
- Walidacja zod wszystkich danych wejściowych w main i hostach; ścieżki normalizowane (`path.resolve`) i sprawdzane „wewnątrz katalogu projektu” tam, gdzie dotyczy (diff, podgląd, discard).
- Lokalny serwer OTLP/bridge: tylko `127.0.0.1`, losowy port, token Bearer (32 bajty losowe) w nagłówku.
- Wtyczki: szczegóły modelu zaufania w [07-plugin-engine.md §2](07-plugin-engine.md).
- Zmienne środowiskowe dziedziczone przez terminale czyszczone z markerów innych terminali/IDE i procesu Electron (lista w [04-terminals.md §2.3](04-terminals.md)).

## 6. Sekwencja startu

1. `app.requestSingleInstanceLock()`; drugi proces przekazuje argv (ścieżki folderów) do pierwszego (`second-instance` → dodaj/aktywuj projekt, focus okna).
2. Override `userData`, jeśli `--user-data-dir=<path>` lub env `OXYTOCIN_USER_DATA_DIR` (testy E2E, wiele profili).
3. `registerSchemesAsPrivileged`, konfiguracja electron-log, `crashReporter.start({ uploadToServer: false })`.
4. `app.whenReady()`:
   1. `SettingsService.load()` (sync odczyt + walidacja + migracje; przy błędzie parsowania → kopia `.corrupt-<ts>` i defaulty + toast).
   2. Równolegle: `ShellEnvService.resolve()` (macOS/Linux; timeout 5 s, fallback `process.env`), start **PTY Host**, **Workspace Host**, **Plugin Host**.
   3. `ProjectService.load()`, `WorkspaceStateService.init()`.
   4. Utworzenie okna (`show: false`, `backgroundColor` = token tła, `titleBarStyle: 'hidden'`, `titleBarOverlay` na Win/Linux), `ready-to-show` → `show()`.
   5. Po `did-finish-load`: przekazanie portu PTY; `PluginService.activateStartupPlugins()` (aktywacje `onStartup`; **terminal spawn czeka maks. 2 s** na zakończenie aktywacji wtyczek wnoszących env — patrz [07 §8.7](07-plugin-engine.md)).
   6. Renderer: `projects:list` + `settings:get` → otwiera ostatnio aktywny projekt → `workspace:load` → odtworzenie układu → `terminals:create` dla paneli terminali (revive, [03 §7](03-projects-workspace.md)).
5. Cel: **pierwszy interaktywny prompt < 1,5 s** od kliknięcia ikony na średniej klasy laptopie z Windows 11 (mierzone w E2E przez `performance` marks).

## 7. Sekwencja zamknięcia

1. `before-quit` / zamknięcie okna → `QuitGuard`: jeśli istnieją terminale z działającym procesem potomnym lub agentem → dialog „N terminals have running processes (Claude Code in ‘api’, npm run dev in ‘web’…). Quit anyway?” (opcja „Don’t ask again” → ustawienie `terminal.confirmOnQuit`).
2. `WorkspaceStateService.flush()` — zapis układów, deskryptorów paneli i (jeśli włączone) snapshotów scrollbacku (`ptyHost.serialize` każdego terminala, limit 1000 linii / 1 MB).
3. `ptyHost.shutdown()` — łagodne zamknięcie PTY (pwsh/cmd: zamknięcie ConPTY; POSIX: SIGHUP), po 3 s `tree-kill` pozostałych.
4. `pluginHost.deactivateAll()` (timeout 2 s), zamknięcie watcherów, zamknięcie DB wtyczek.
5. `app.exit()`.

## 8. Obsługa błędów i odporność

| Sytuacja | Zachowanie |
|---|---|
| Brak `git` w PATH | Panel Zmian: karta „Git not found” + link do instalacji + ustawienie `git.path`. Reszta aplikacji działa. |
| Folder projektu usunięty/przeniesiony | Projekt oznaczony „Folder not found” (szara ikona ostrzeżenia), akcje: „Locate folder…”, „Remove from list”. Terminale nie są tworzone. |
| Spawn powłoki nieudany | Panel pokazuje błąd z komunikatem i przyciskami „Change profile” / „Try again”. Log z pełną ścieżką i argumentami. |
| Uszkodzony plik stanu/ustawień | Kopia `.corrupt-<ts>`, powrót do defaultów, toast z informacją. |
| Wyjątek w wtyczce (aktywacja) | Wtyczka oznaczona `failed`, reszta działa; w menedżerze wtyczek stack trace + „Reload”. |
| Wyjątek w renderze komponentu | React Error Boundary na poziomie: sekcji sidebara, panelu dockview, całej aplikacji (ostatnia deska: „Reload UI” → reload renderera; terminale przeżywają dzięki PTY Host). |
| Nieobsłużony wyjątek w main | Log + dialog „Something went wrong” z opcją restartu aplikacji; `process.on('uncaughtException')` nie ukrywa błędu. |

## 9. Logowanie i diagnostyka

- `electron-log` 5: plik `userData/logs/main.log` (rotacja 5 MB × 3), hosty logują przez RPC `log` do main (jeden plik z prefiksem `[pty]`, `[ws]`, `[plg:<pluginId>]`) — prostsze niż wiele plików.
- Poziomy: `error`, `warn`, `info` (domyślnie), `debug` (ustawienie `diagnostics.logLevel` lub env `OXYTOCIN_LOG=debug`).
- **Nigdy nie loguj** treści wpisywanej do terminala, zawartości plików, tokenów, treści rozmów agentów.
- Polecenia (paleta / menu „Help”): „Open Logs Folder”, „Toggle Developer Tools”, „Show Oxytocin Processes” (PID, RAM, CPU z `app.getAppMetrics()`), „Copy Diagnostic Info” (wersje, platforma, ustawienia bez sekretów).
- Metryki wydajności: `performance.mark` w rendererze (start, project-switch, terminal-first-output) + log czasów w trybie debug.

## 10. Konwencje kodu

- **Wszystko po angielsku** (ADR-018): identyfikatory, komentarze, JSDoc, komunikaty logów i błędów, teksty UI, nazwy testów, README, commity. Teksty dialogów i komunikatów podane w tym planie po polsku są opisem intencji — w kodzie używaj angielskich odpowiedników ([02 §13](02-ui-ux.md)).
- Licencja MIT (ADR-020): bez nagłówków licencyjnych w każdym pliku (wystarczy `LICENSE`); pliki adaptowane z projektów zewnętrznych (np. shell integration z VS Code) zachowują oryginalny nagłówek licencji i źródło.
- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (jeśli nie utrudnia zod), `noImplicitOverride`.
- **Named exports** (bez default export poza komponentami lazy).
- Nazewnictwo plików: `kebab-case.ts`, komponenty React `PascalCase.tsx`. Typy domenowe w `shared/domain`.
- Wzorzec **`Disposable`** (`{ dispose(): void }`) i `DisposableStore` dla subskrypcji we wszystkich procesach; typowany `Emitter<T>` z `event: Event<T>` (jak w VS Code).
- Serwisy w main to klasy z jawnie wstrzykiwanymi zależnościami przez konstruktor (bez frameworka DI); kompozycja w `src/main/index.ts`.
- Asynchroniczność: `async/await`; zero synchronicznego I/O w main po starcie (poza odczytem ustawień przy starcie).
- Nie przekazuj danych terminala przez stan React ani Zustand — tylko bezpośrednio do instancji xterm.
- Komentarze tylko tam, gdzie wyjaśniają „dlaczego” (np. obejścia ConPTY).
- Każdy moduł platformowo-zależny: `*.win.ts` / `*.posix.ts` za wspólnym interfejsem.

## 11. Konfiguracja buildu (szkice)

```ts
// electron.vite.config.ts (szkic — przed implementacją sprawdź dokumentację electron-vite 5:
// w nowszych wersjach externalizacja zależności może być opcją `build.externalizeDeps` zamiast pluginu)
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';

const alias = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],           // node-pty, @parcel/watcher, @vscode/windows-process-tree zostają external
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          ptyHost: resolve('src/pty-host/index.ts'),
          workspaceHost: resolve('src/workspace-host/index.ts'),
          pluginHost: resolve('src/plugin-host/index.ts'),
        },
      },
    },
  },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias } },
  renderer: {
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwind()],
    worker: { format: 'es' },                     // Monaco editor.worker
  },
});
```

```yaml
# electron-builder.yml (szkic)
appId: dev.oxytocin.app
productName: Oxytocin
directories: { output: release, buildResources: resources/build }
files: ["out/**", "package.json"]
asar: true
asarUnpack:
  - "**/node_modules/node-pty/**"
  - "**/node_modules/@parcel/watcher*/**"
  - "**/node_modules/@vscode/windows-process-tree/**"
extraResources:
  - { from: "plugins/usage-monitor/dist", to: "plugins/usage-monitor" }
  - { from: "plugins/markdown-preview/dist", to: "plugins/markdown-preview" }
  - { from: "resources/shell-integration", to: "shell-integration" }
  - { from: "LICENSE", to: "LICENSE" }
  - { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" }
win: { target: [nsis], icon: resources/build/icon.ico }
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true }
mac: { target: [dmg, zip], category: public.app-category.developer-tools }
linux: { target: [AppImage, deb], category: Development }
afterPack: scripts/after-pack-fuses.cjs
npmRebuild: false        # prebuildy — nie kompilujemy (brak toolchainu); zweryfikować w spike S1
```

Ścieżki runtime: wbudowane wtyczki `app.isPackaged ? path.join(process.resourcesPath, 'plugins') : path.resolve('plugins')` — zawsze przez `src/main/app/paths.ts`.
