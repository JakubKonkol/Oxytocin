# 07 — Domena 4: Architektura wtyczek (Plugin Engine)

Wymagania: **R-PLG-1** (technologie webowe), **R-PLG-2** (dynamiczne dokowanie w slotach), **R-TERM-4** (widoki wtyczek w panelach centralnych). Wtyczki wbudowane: **Usage Monitor** ([08](08-usage-monitor.md)) i **Markdown Preview** (§11).

## 1. Cele i non-goals

**Cele**
- Niski próg wejścia: UI wtyczki to zwykła strona HTML/JS/CSS (dowolny framework lub żaden).
- Dwie opcjonalne części: **backend** (Node, w Plugin Host — dostęp do systemu plików, sieci, API `oxy`) i **widoki** (web, w iframe).
- Deklaratywne kontrybucje w manifeście (sloty, polecenia, ustawienia, profile terminali, reguły agentów, openery plików), aktywacja leniwa.
- Stabilne, wersjonowane API z typami TS (`@oxytocin/plugin-api`) i SDK widoków (`@oxytocin/plugin-sdk`).
- Awaria wtyczki nie wpływa na rdzeń ani inne wtyczki (poza wspólnym Plugin Host — patrz §6.5).

**Non-goals (v1):** marketplace, automatyczne aktualizacje wtyczek, piaskownica bezpieczeństwa dla backendów Node (niemożliwa do zapewnienia w Node — patrz §2), widoki wtyczek w osobnych oknach.

## 2. Model zaufania i bezpieczeństwo

| Warstwa | Izolacja | Gwarancja |
|---|---|---|
| **Widok (iframe)** | Osobny origin `oxy-plugin://<pluginId>`, `sandbox="allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox"` (same-origin dotyczy **własnego** originu wtyczki, nie powłoki), rygorystyczna CSP, brak preloadu, brak Node. | Widok nie ma dostępu do DOM powłoki, `window.oxy`, IPC, sieci (CSP `connect-src 'none'`) ani plików. Komunikuje się wyłącznie przez `MessagePort` z API sprawdzanym przez powłokę. |
| **Backend (Plugin Host)** | Osobny proces (utilityProcess) wspólny dla wszystkich wtyczek; per-wtyczkowe obiekty API. | **Brak granicy bezpieczeństwa** — backend ma pełne możliwości Node (jak rozszerzenia VS Code). Uprawnienia w manifeście są „barierkami” dla API `oxy` i informacją dla użytkownika, nie sandboxem. |

Konsekwencje:
- Wtyczki wbudowane — zaufane.
- Wtyczki instalowane przez użytkownika (M9) — przy pierwszym włączeniu dialog zgody: nazwa, wydawca, lista uprawnień, ostrzeżenie „Plugins with a backend have full access to your computer — install only from sources you trust”.
- Tryb deweloperski („Load plugin from folder…”) — wymaga włączenia `plugins.developerMode`.

## 3. Anatomia wtyczki

```
my-plugin/
├─ package.json            # standardowe pola npm + sekcja "oxytocin" (manifest)
├─ dist/
│  ├─ host.js              # backend (ESM), eksportuje activate/deactivate — opcjonalny
│  └─ views/
│     ├─ sidebar.html      # widoki; ładują własne skrypty/style ze ścieżek względnych
│     ├─ sidebar.js
│     └─ dashboard.html
├─ icon.svg
└─ README.md
```

Wtyczka jest dostarczana **zbudowana** (bundel ESM/CJS, bez `node_modules` w runtime, poza zależnościami natywnymi — niezalecane). Szablon buildu: Vite (widoki) + esbuild/Vite SSR (host). Wtyczki wbudowane budowane przez `scripts/build-plugins.ts`.

## 4. Manifest

```jsonc
// package.json
{
  "name": "@oxytocin/usage-monitor",
  "version": "1.0.0",
  "license": "MIT",
  "oxytocin": {
    "id": "oxytocin.usage-monitor",             // ^[a-z0-9]+(\.[a-z0-9-]+)+$ — używany jako host w oxy-plugin://
    "displayName": "Usage Monitor",
    "description": "Token usage and API costs of AI coding agents",
    "publisher": "oxytocin",
    "icon": "icon.svg",
    "engine": "^0.1.0",                          // semver zakres wersji API Oxytocin
    "main": "dist/host.js",                      // opcjonalny backend
    "activationEvents": ["onStartup"],           // onStartup | onView:<viewId> | onPanel:<panelType> | onCommand:<cmdId> | onProjectOpen | onAgentDetected:<agentId> | *
    "permissions": ["terminals.env", "terminals.read-metadata", "agents.read", "projects.read", "fs.read-home", "net.listen-local", "net.fetch"],
    "contributes": {
      "views": [
        { "id": "usage.sidebar", "slot": "sidebar", "title": "Usage",
          "entry": "dist/views/sidebar.html", "icon": "icon.svg", "order": 300,
          "initialHeight": 180, "minHeight": 90 }
      ],
      "panels": [
        { "type": "usage.dashboard", "title": "Usage Dashboard",
          "entry": "dist/views/dashboard.html", "icon": "icon.svg", "singleton": "global" }
      ],
      "statusBarItems": [
        { "id": "usage.today", "alignment": "right", "priority": 100 }
      ],
      "commands": [
        { "id": "usage.openDashboard", "title": "Usage: Open Dashboard", "icon": "graph" },
        { "id": "usage.refreshPricing", "title": "Usage: Refresh Pricing" }
      ],
      "configuration": {
        "prefix": "usage",
        "properties": {
          "usage.liveTelemetry.claudeCode": { "type": "boolean", "default": false, "description": "Inject OpenTelemetry variables into terminals (Claude Code)" },
          "usage.pricing.autoUpdate": { "type": "boolean", "default": true }
        }
      },
      "fileOpeners": [],
      "terminalProfiles": [],
      "agents": []
    }
  }
}
```

Walidacja: schemat zod `PluginManifestSchema` w `src/shared/domain/plugin.ts`; błędy walidacji → wtyczka `invalid` z listą błędów w menedżerze wtyczek. `engine` sprawdzany pakietem `semver` względem `OXYTOCIN_API_VERSION` (stała w `shared/constants.ts`, start `0.1.0`).

## 5. Odkrywanie, instalacja, włączanie

- **Lokalizacje:** (1) wbudowane: `resources/plugins/*` (dev: `plugins/*/` w repo), (2) użytkownika: `userData/plugins/*` (M9), (3) deweloperskie: ścieżki z `plugins.devPaths` (tryb dev).
- Konflikt id: dev > user > builtin (dev nadpisuje, by można było rozwijać wtyczkę wbudowaną).
- Stan włączenia: `settings.plugins.enabled: Record<pluginId, boolean>` (brak wpisu = włączona dla wbudowanych, wyłączona dla nowych zewnętrznych do czasu zgody).
- `PluginService` (main): skan przy starcie → `PluginDescriptor[]` (`{ id, version, displayName, source, state: 'enabled'|'disabled'|'invalid'|'incompatible'|'failed'|'active', errors?, contributes, permissions }`) → rejestr kontrybucji → `plugins:contributions` do renderera.
- Menedżer wtyczek (M5, minimalny; pełny w M7): lista, włącz/wyłącz, „Reload”, „Show logs”, „Open folder”, w trybie dev „Load plugin from folder…” i „Open view DevTools”.

## 6. Plugin Host i API backendu

### 6.1 Cykl życia

1. Main uruchamia Plugin Host i przekazuje listę włączonych wtyczek (ścieżki, manifesty, uprawnienia, ustawienia).
2. Plugin Host rejestruje zdarzenia aktywacji. `onStartup` aktywowane od razu (równolegle, każdy z timeoutem 5 s na `activate` — przekroczenie = ostrzeżenie w logu, nie przerwanie).
3. Aktywacja: `const mod = await import(pathToFileURL(main).href)`; `await mod.activate(ctx)`. Wyjątek → stan `failed`, powiadomienie w menedżerze.
4. Leniwa aktywacja: gdy renderer montuje widok/panel wtyczki, gdy wywołano jej polecenie itd. — main wysyła `activate(pluginId, reason)`; widok czeka (placeholder „Loading…”) aż backend zgłosi gotowość providera widoku (timeout 10 s → komunikat błędu w widoku).
5. Dezaktywacja (wyłączenie, przeładowanie, wyjście): `await mod.deactivate?.()` (timeout 2 s) → `dispose()` wszystkich `ctx.subscriptions` → usunięcie kontrybucji dynamicznych (status bar, env, providery widoków).

### 6.2 Izolacja w obrębie hosta

- Każde wywołanie API i każdy callback wtyczki opakowany `try/catch` z przypisaniem błędu do wtyczki (`log.error` z `pluginId`).
- `unhandledRejection` / `uncaughtException` w hoście: jeśli stack wskazuje ścieżkę wtyczki → oznacz ją jako `failed` i dezaktywuj; inaczej crash hosta → restart (polityka z [01 §2.2](01-architecture.md)).
- Wykrywanie zawieszeń: main pinguje host co 5 s; brak odpowiedzi 15 s → kill + restart + wtyczka aktywna w momencie zawieszenia (ostatnie wywołanie w toku) oznaczona jako podejrzana (wyłączana po 2 incydentach).

### 6.3 Fabryka API

`createApi(plugin: LoadedPlugin): OxytocinApi` — osobny obiekt per wtyczka; metody wymagające uprawnień sprawdzają `plugin.permissions` i rzucają `PermissionError`. Wywołania wymagające rdzenia to RPC do main (`plugin-host ↔ main` przez `createPortRpc`); zdarzenia z main są rozsyłane do subskrybentów w hoście.

### 6.4 Publiczne API backendu — `@oxytocin/plugin-api` (d.ts, szkic v0.1)

```ts
// packages/plugin-api/index.d.ts
export interface Disposable { dispose(): void }
export type Event<T> = (listener: (e: T) => unknown) => Disposable;
/** UI is English-only (ADR-018); kept as an alias so localization could be added later without breaking the API. */
export type Localized = string;

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginContext {
  readonly plugin: { id: string; version: string; path: string; builtin: boolean };
  readonly subscriptions: Disposable[];
  readonly storage: PluginStorage;
  readonly log: Logger;
  readonly oxy: OxytocinApi;
}

export interface PluginStorage {
  readonly globalDir: string;                     // userData/plugin-data/<pluginId>/ (utworzony)
  projectDir(projectId: string): string;          // userData/plugin-data/<pluginId>/projects/<projectId>/
  get<T>(key: string): T | undefined;             // KV (JSON, atomowy zapis, ≤ 1 MB)
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Logger { debug(m: string, meta?: unknown): void; info(...): void; warn(...): void; error(m: string, err?: unknown): void }

export interface OxytocinApi {
  readonly version: string;                       // wersja API
  readonly env: { appVersion: string; platform: 'win32' | 'darwin' | 'linux'; locale: string; homeDir: string; userDataDir: string };
  readonly projects: ProjectsApi;
  readonly terminals: TerminalsApi;
  readonly agents: AgentsApi;
  readonly git: GitApi;
  readonly ui: UiApi;
  readonly commands: CommandsApi;
  readonly settings: SettingsApi;
}

// ── Projekty ─────────────────────────────────────────────── (uprawnienie: projects.read)
export interface ProjectInfo { id: string; name: string; rootPath: string; color: string }
export interface ProjectsApi {
  list(): Promise<ProjectInfo[]>;
  getActive(): Promise<ProjectInfo | undefined>;
  findByPath(path: string): Promise<ProjectInfo | undefined>;   // najdłuższy prefiks — do atrybucji cwd
  onDidChangeActive: Event<ProjectInfo | undefined>;
  onDidChange: Event<ProjectInfo[]>;
}

// ── Terminale ────────────────────────────────────────────────
export interface TerminalMeta {
  id: string; projectId: string; profileId: string; title: string; pid?: number;
  status: 'starting' | 'running' | 'exited'; exitCode?: number;
  kind: 'shell' | 'process' | 'agent'; agentId?: string; createdAt: number;
}
export interface TerminalsApi {
  list(filter?: { projectId?: string }): Promise<TerminalMeta[]>;           // terminals.read-metadata
  onDidOpen: Event<TerminalMeta>; onDidClose: Event<{ id: string }>; onDidChange: Event<TerminalMeta>;
  create(o: { projectId: string; profileId?: string; cwd?: string; title?: string; command?: string;
              placement?: 'active-group' | 'right' | 'below' }): Promise<TerminalMeta>;   // terminals.create
  sendText(id: string, text: string, opts?: { addNewLine?: boolean }): Promise<void>;     // terminals.write
  onData(id: string, listener: (data: string) => void): Disposable;                        // terminals.read-output (surowy strumień VT)
  readonly environment: EnvironmentCollection;                                             // terminals.env
}
/** Zakres wpisu: brak = wszystkie terminale; projectId = terminale projektu; profileIds = tylko terminale z tymi profilami. */
export interface EnvScope { projectId?: string; profileIds?: string[] }
/**
 * Wartości mogą zawierać `${env:NAME}` — rdzeń podstawia wartość z już złożonego środowiska terminala
 * (np. `oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID}`). Brak zmiennej → pusty string.
 */
export interface EnvironmentCollection {
  replace(name: string, value: string, scope?: EnvScope): void;
  append(name: string, value: string, scope?: EnvScope): void;
  prepend(name: string, value: string, scope?: EnvScope): void;
  delete(name: string, scope?: EnvScope): void;
  clear(): void;
  /** Wtyczka deklaruje, że jej kolekcja jest kompletna (odblokowuje spawn przy starcie, §8.7). */
  ready(): void;
  description?: Localized;                        // shown in the "environment out of date" tooltip
}

// ── Agenci ─────────────────────────────────────────────────── (agents.read)
export interface AgentSnapshot {
  terminalId: string; projectId: string; agentId: string; displayName: string; provider: string;
  pid: number; sessionId?: string; state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown';
  waitingFor?: string; since: number; cwd?: string;
}
export interface AgentsApi {
  list(): Promise<AgentSnapshot[]>;
  onDidChange: Event<AgentSnapshot[]>;
  /** Wtyczka może dostarczyć sessionId (np. z korelacji plików Codex/Gemini) — rdzeń doda go do AgentInfo. */
  reportSession(terminalId: string, info: { sessionId: string; source: string }): void;       // agents.annotate
}

// ── Git ───────────────────────────────────────────────────── (git.read)
export interface GitApi {
  getStatus(projectId: string): Promise<RepoStatusLite | undefined>;
  onDidChangeStatus: Event<RepoStatusLite>;
}
export interface RepoStatusLite { projectId: string; branch?: string; files: { path: string; status: string; additions?: number; deletions?: number }[] }

// ── UI ───────────────────────────────────────────────────────
export interface UiApi {
  registerViewProvider(viewId: string, provider: ViewProvider): Disposable;        // viewId z contributes.views
  registerPanelProvider(panelType: string, provider: ViewProvider): Disposable;    // panelType z contributes.panels
  openPanel(panelType: string, o?: { projectId?: string; params?: unknown; title?: Localized; placement?: 'active-group' | 'right' | 'below' }): Promise<void>;
  statusBarItem(id: string): StatusBarItem;                                        // id z contributes.statusBarItems
  showNotification(o: { level: 'info' | 'warning' | 'error'; message: Localized; detail?: string;
                        actions?: { id: string; title: Localized }[]; os?: boolean }): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;                                        // tylko http/https
  openInEditor(path: string, line?: number, column?: number): Promise<void>;
}
export interface ViewProvider { resolve(view: PluginView): void | Promise<void> }
export interface PluginView {
  readonly id: string;                           // instancja widoku/panelu
  readonly kind: 'view' | 'panel';
  readonly projectId?: string;
  readonly params?: unknown;
  title?: Localized;
  badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | undefined;
  readonly visible: boolean;
  postMessage(msg: unknown): Promise<boolean>;   // false gdy widok nie istnieje
  onDidReceiveMessage: Event<unknown>;
  onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): Disposable;   // obsługa view.request()
  onDidChangeVisibility: Event<boolean>;
  onDidDispose: Event<void>;
}
export interface StatusBarItem {
  text: string;                                   // może zawierać ikony $(codicon-name)
  tooltip?: Localized;
  color?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  command?: string | { id: string; args?: unknown[] };
  show(): void; hide(): void; dispose(): void;
}

// ── Polecenia ────────────────────────────────────────────────
export interface CommandsApi {
  register(id: string, handler: (...args: unknown[]) => unknown): Disposable;      // id z contributes.commands (lub prywatne z prefiksem pluginId.)
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;                 // polecenia rdzenia i innych wtyczek
}

// ── Ustawienia ───────────────────────────────────────────────
export interface SettingsApi {
  get<T>(key: string): T;                         // tylko klucze z własnym prefiksem lub publiczne klucze rdzenia (appearance.*)
  update(key: string, value: unknown): Promise<void>;   // tylko własny prefiks
  onDidChange(keyPrefix: string, listener: () => void): Disposable;
}
```

Polecenia rdzenia dostępne dla wtyczek (wybrane): `oxytocin.terminal.new`, `oxytocin.terminal.focus`, `oxytocin.project.activate`, `oxytocin.diff.open`, `oxytocin.changes.refresh`, `oxytocin.panel.focus`.

### 6.5 Jeden czy wiele hostów?

v1: **jeden** Plugin Host dla wszystkich wtyczek (mniej pamięci, prostsze). Wtyczka zawieszająca pętlę zdarzeń blokuje pozostałe — wykrywane pingiem (§6.2). Przyszłość (ADR do podjęcia w M9): osobny host dla wtyczek zewnętrznych.

## 7. Widoki wtyczek (iframe)

### 7.1 Protokół `oxy-plugin://`

- Rejestracja: `registerSchemesAsPrivileged` (standard, secure, supportFetchAPI, corsEnabled, stream) + `protocol.handle('oxy-plugin', handler)` w sesji domyślnej.
- URL: `oxy-plugin://<pluginId>/<ścieżka w katalogu wtyczki>` (host = id wtyczki; id jest zgodne z regułami nazw hostów).
- Handler: `decodeURIComponent(pathname)` → `path.resolve(pluginRoot, '.' + pathname)` → **musi** zaczynać się od `pluginRoot + sep` (ochrona przed `..`) → `net.fetch(pathToFileURL(file))` → odpowiedź z nagłówkami: `Content-Type` (z rozszerzenia), `Content-Security-Policy` (§7.2), `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` (dev) / `max-age=3600` (prod). Brak pliku → 404.
- Wtyczka niewłączona/nieznana → 404.

### 7.2 CSP widoków

```
default-src 'none';
script-src oxy-plugin://<id>;
style-src oxy-plugin://<id> 'unsafe-inline';
img-src oxy-plugin://<id> data: blob:;
font-src oxy-plugin://<id> data:;
media-src oxy-plugin://<id> blob:;
connect-src 'none';
frame-src 'none';
worker-src oxy-plugin://<id> blob:;
base-uri 'none'; form-action 'none'; frame-ancestors app://oxytocin http://localhost:*
```
(W prod `frame-ancestors app://oxytocin`.) Dostęp do danych z zewnątrz — tylko przez backend wtyczki.

### 7.3 `PluginFrame` (renderer)

```tsx
<iframe
  src={`oxy-plugin://${pluginId}/${entry}?viewId=${instanceId}`}
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerPolicy="no-referrer"
  title={title}
  className="h-full w-full border-0 bg-transparent"
/>
```
- Kontener panelu dockview/pane'a z `renderer: 'always'` (brak przeładowań przy przenoszeniu).
- Nakładka ładowania do czasu `oxy:ready`; nakładka błędu przy crashu backendu lub timeout (z przyciskiem „Reload view”).
- `pointer-events: none` w trakcie DnD/zmiany rozmiaru ([05 §7](05-layout-center.md)).

### 7.4 Handshake

1. SDK w iframe: `window.parent.postMessage({ type: 'oxy:hello', sdkVersion }, '*')`.
2. Powłoka (listener `message` na `window`): weryfikuje `event.source === iframe.contentWindow` i `event.origin === 'oxy-plugin://' + pluginId` → tworzy `new MessageChannel()` → `iframe.contentWindow.postMessage({ type: 'oxy:init', viewId, kind, projectId, params, locale, theme: tokens, state }, event.origin, [channel.port2])`.
3. Od tej chwili cała komunikacja przez `channel.port1` (powłoka) ⇄ `port2` (widok). `window.postMessage` nie jest dalej używany.

### 7.5 Routing wiadomości (v1: przez powłokę i main — ADR-016)

```
iframe (SDK) ⇄ MessagePort ⇄ renderer ViewBridge ⇄ IPC 'plugins:viewMessage' ⇄ main ViewRouter ⇄ RPC ⇄ Plugin Host (PluginView)
```
- Koperta: `{ viewId, pluginId, kind: 'msg' | 'req' | 'res' | 'evt', id?, method?, payload }`; limit rozmiaru 1 MB (większe odrzucane z błędem), limit częstotliwości 200 wiadomości/s na widok.
- `ViewBridge` (renderer) obsługuje lokalnie wiadomości „powłokowe” (bez udziału backendu): `executeCommand`, `openPanel`, `setTitle`, `setBadge`, `showContextMenu`, `setState`, `keydown`, `openExternal`, `copyToClipboard`. Każda sprawdzana względem uprawnień wtyczki.
- Pozostałe (`msg`, `req`) → main → Plugin Host → `PluginView.onDidReceiveMessage` / `onRequest`. Odpowiedzi i `postMessage` backendu wracają tą samą drogą.
- Widoki wtyczek **bez backendu** mogą używać tylko wiadomości powłokowych.
- Optymalizacja na przyszłość: bezpośredni `MessagePort` iframe ⇄ Plugin Host (transfer przez preload) — jeśli pomiary pokażą potrzebę.

### 7.6 Klawiatura

SDK nasłuchuje `keydown` (capture) w iframe i dla kombinacji z Ctrl/Alt/Meta lub F-klawiszy wysyła `{ kind: 'keydown', key, code, ctrlKey, shiftKey, altKey, metaKey }` do powłoki; `KeybindingService` rozwiązuje w kontekście `pluginViewFocus`. Jeśli skrót jest zarezerwowany przez powłokę, SDK dostaje `preventDefault` w odpowiedzi synchronicznie niemożliwe — dlatego SDK wywołuje `preventDefault()` z góry dla listy skrótów globalnych przekazanej w `oxy:init` (`reservedKeybindings`). Escape zawsze zostaje w widoku.

### 7.7 Motyw

`oxy:init.theme` zawiera mapę tokenów (`--bg-card`, `--text-primary`, …, fonty). SDK ustawia je jako CSS variables na `:root` iframe i dołącza `@oxytocin/plugin-sdk/theme.css` (reset, typografia, scrollbary, podstawowe elementy: przyciski, inputy, tabele, `.oxy-badge`, `.oxy-progress`). Zmiana motywu → `evt: themeChanged`.

### 7.8 Stan i widoczność

- `oxy.setState(obj)` (≤ 256 KB JSON) — powłoka przechowuje stan per instancja widoku; dla paneli trafia do deskryptora `PanelDescriptor.state` (persystencja z układem), dla widoków sidebara do `ui-state.json`. Przy ponownym utworzeniu iframe'a stan wraca w `oxy:init.state`.
- `evt: visibility { visible }` przy ukryciu/pokazaniu (przełączenie projektu, zwinięcie pane'a, nieaktywny tab). Widoki powinny wtedy wstrzymywać animacje/odświeżanie; backend widzi to jako `PluginView.onDidChangeVisibility`.
- Widoki globalne (sidebar) nie zależą od projektu; panele otwarte w workspace projektu mają `projectId`.

### 7.9 SDK widoku — `@oxytocin/plugin-sdk`

```ts
// packages/plugin-sdk/src/view.ts (API publiczne)
export interface OxyView<Params = unknown, State = unknown> {
  readonly viewId: string;
  readonly kind: 'view' | 'panel';
  readonly projectId?: string;
  readonly params: Params;
  readonly locale: string;
  getState(): State | undefined;
  setState(state: State): void;
  postMessage(msg: unknown): void;                                  // → backend PluginView.onDidReceiveMessage
  onMessage(cb: (msg: unknown) => void): () => void;                // ← backend view.postMessage
  request<R = unknown, P = unknown>(method: string, params?: P, opts?: { timeoutMs?: number }): Promise<R>;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  onThemeChange(cb: (tokens: Record<string, string>) => void): () => void;
  executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R>;
  openPanel(panelType: string, o?: { params?: unknown; placement?: 'active-group' | 'right' | 'below' }): Promise<void>;
  setTitle(title: string): void;
  setBadge(badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' }): void;
  showContextMenu(items: { id: string; label: string; disabled?: boolean; separator?: boolean }[], at: { x: number; y: number }): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
}
export function connect<P = unknown, S = unknown>(opts?: { timeoutMs?: number }): Promise<OxyView<P, S>>;
```
Paczka eksportuje też `theme.css` i helpery React (`useOxyView()`, `useOxyMessage()`), aby wtyczki wbudowane nie powtarzały kodu.

## 8. Sloty i kontrybucje (R-PLG-2)

### 8.1 `sidebar` (widoki w lewym panelu)

- Każdy wpis `contributes.views` z `slot: "sidebar"` → pane w `PaneviewReact` po sekcjach rdzenia (Projekty `order 0`, Zmiany `order 100`); `order` wtyczki domyślnie 1000; Usage Monitor 300 (zaraz pod Zmianami — „lewy panel dolny” z prototypu).
- Nagłówek pane'a: ikona, tytuł (lokalizowany), badge (z `view.badge`), akcje: „Open as panel” (jeśli wtyczka ma panel), ⋯ (ukryj sekcję, przeładuj widok).
- Aktywacja wtyczki `onView:<id>` przy pierwszym rozwinięciu pane'a (lub od razu, jeśli rozwinięty przy starcie).

### 8.2 `panels` (obszar centralny)

- Typy paneli z `contributes.panels` otwierane przez: polecenia, `oxy.ui.openPanel`, SDK `openPanel`, openery plików (§8.6), menu kontekstowe.
- `singleton`: `"global"` (jedna instancja w całej aplikacji — przy otwarciu w innym projekcie przenoszona? **Nie** — panel globalny otwierany jest w bieżącym projekcie, a istniejąca instancja w innym projekcie zostaje; „global” oznacza jedną instancję **na workspace**, bez duplikatów), `"project"` (jedna na projekt dla tych samych `params`), `false` (dowolnie wiele).
- Deskryptor panelu przechowuje `params` i `state` — przywracany po restarcie.

### 8.3 `statusBarItems`

Deklaratywne (bez iframe'ów — pasek statusu musi być lekki): id, `alignment: 'left' | 'right'`, `priority` (większy = bliżej krawędzi). Treść i zachowanie ustawiane z backendu przez `oxy.ui.statusBarItem(id)`. Rdzeń renderuje tekst z ikonami codicon, tooltip, kolor, klik → polecenie.

### 8.4 `commands`

Zarejestrowane w rejestrze poleceń rdzenia (paleta, skróty użytkownika, menu). Wywołanie → aktywacja `onCommand:<id>` (jeśli trzeba) → handler w backendzie. Polecenie bez handlera po aktywacji → błąd „Command not available”.

### 8.5 `configuration`

- Klucze muszą zaczynać się od zadeklarowanego `prefix` (unikalny; konflikt → wtyczka `invalid`).
- Schemat: podzbiór JSON Schema (`type`: boolean/number/integer/string/array/object, `default`, `enum`, `enumDescriptions`, `minimum`, `maximum`, `description`, `markdownDescription`) — renderowany w UI ustawień (M7) jako formularz.
- Wartości w `settings.json` użytkownika; walidacja przy zapisie.

### 8.6 `fileOpeners`

```jsonc
"fileOpeners": [
  { "id": "markdown.preview", "extensions": [".md", ".markdown", ".mdx"], "panelType": "markdown.preview",
    "title": "Open Preview", "default": false }
]
```
Rdzeń dodaje pozycję do menu kontekstowego drzewa Zmian i do akcji linków plików w terminalu; `panelType` otwierany z `params: { projectId, path }`. `default: true` → używany przy Ctrl+Klik zamiast diffu/edytora (dla danego rozszerzenia).

### 8.7 Wkład w środowisko terminali (`terminals.env`)

- `oxy.terminals.environment` — kolekcja per wtyczka, trzymana w Plugin Host i synchronizowana do main (`EnvironmentCollectionService`) przy każdej zmianie (debounce 50 ms).
- **Blokada startowa:** przy starcie aplikacji `TerminalService.create()` czeka, aż każda włączona wtyczka z uprawnieniem `terminals.env` i aktywacją `onStartup` wywoła `environment.ready()` (lub zakończy `activate`) — **maks. 2 s** łącznie; po timeout spawn następuje, a terminal dostaje `envStale` po późniejszej zmianie kolekcji.
- Zmiana kolekcji po utworzeniu terminali → `envStale = true` dla terminali, których dotyczy zakres (globalny lub projekt).
- Kolekcje są stosowane w kroku 6 składania env ([04 §2.3](04-terminals.md)); `append/prepend` dla `PATH` używają separatora platformy.
- Zakres `profileIds` pozwala ograniczyć zmienne do terminali uruchomionych konkretnymi profilami (np. tylko profile agentów) — zmniejsza „promień rażenia” ogólnych zmiennych jak `OTEL_*`.
- Podstawienia `${env:NAME}` rozwijane po złożeniu kroków 1–5 (dzięki temu wtyczka może odwołać się do `OXYTOCIN_TERMINAL_ID` bez znajomości terminala w chwili rejestracji).

### 8.8 `terminalProfiles` i `agents`

- `terminalProfiles`: profile dodawane do listy (np. wtyczka „Aider” dodaje profil z komendą `aider --model …`). Format jak `TerminalProfile` bez `source`.
- `agents`: dodatkowe reguły wykrywania (`AgentRule` bez RegExp — w manifeście jako stringi wzorców, kompilowane przez rdzeń z flagą `i`).

### 8.9 Menu (M7+)

`contributes.menus` z punktami: `changes/item/context`, `terminal/context`, `terminal/title`, `project/context`, `titlebar/actions` — wpisy `{ command, when?, group? }`. W M5 tylko `fileOpeners` (wystarczające dla Markdown Preview).

## 9. Uprawnienia

| Uprawnienie | Daje dostęp do |
|---|---|
| `projects.read` | `oxy.projects.*` |
| `terminals.read-metadata` | `oxy.terminals.list/onDid*` |
| `terminals.create` | `oxy.terminals.create` |
| `terminals.write` | `oxy.terminals.sendText` |
| `terminals.read-output` | `oxy.terminals.onData` (surowy output — wrażliwe!) |
| `terminals.env` | `oxy.terminals.environment` |
| `agents.read` / `agents.annotate` | `oxy.agents.list/onDidChange` / `reportSession` |
| `git.read` | `oxy.git.*` |
| `fs.read-project` | informacyjne (backend czyta pliki projektów) |
| `fs.read-home` | informacyjne (np. `~/.claude`, `~/.codex`) |
| `net.listen-local` | informacyjne (lokalny serwer, np. OTLP) |
| `net.fetch` | informacyjne (backend pobiera dane z internetu, np. cennik) |
| `notifications.os` | `showNotification({ os: true })` |

Uprawnienia „informacyjne” są pokazywane w dialogu zgody i menedżerze wtyczek (backend Node i tak może to zrobić — §2).

## 10. Tworzenie wtyczek (developer experience)

- `plugins.developerMode: true` → w menedżerze „Load plugin from folder…” (dodaje do `plugins.devPaths`), obserwacja `dist/` wtyczki (fs.watch) → automatyczne przeładowanie (dezaktywacja → ponowny import z parametrem cache-busting `?v=<ts>` → aktywacja → przeładowanie iframe'ów).
- DevTools widoku: iframe'y są widoczne w DevTools głównego okna (wybór kontekstu ramki); polecenie „Plugins: Open DevTools” otwiera DevTools powłoki.
- Debugowanie backendu: `OXYTOCIN_INSPECT_HOSTS=1` → Plugin Host z `--inspect=9232` (chrome://inspect).
- Logi wtyczki: `ctx.log` → plik logu z prefiksem `[plg:<id>]` + widok „Logs” w menedżerze (ostatnie 500 wpisów).
- Szablon (M9): `npm create oxytocin-plugin` (Vite + React/vanilla, host TS, manifest, skrypt `dev`).

## 11. Wtyczka wbudowana: Markdown Preview

Cel: podgląd plików Markdown generowanych przez agentów (plany, raporty, README) w panelu obok terminala.

- Manifest: `id: "oxytocin.markdown-preview"`, `activationEvents: ["onPanel:markdown.preview", "onCommand:markdown.openPreview"]`, `permissions: ["projects.read", "fs.read-project"]`, `contributes.panels: [{ type: "markdown.preview", entry: "dist/views/preview.html", singleton: false }]`, `contributes.fileOpeners` (§8.6), polecenie `markdown.openPreview` (argument ścieżka; bez argumentu → quick pick plików `.md` projektu, max 500, z `git ls-files` + nieśledzone).
- Backend: na `resolve(view)` → walidacja, że `params.path` leży w `rootPath` projektu → odczyt pliku → render **w backendzie**: `markdown-it` (GFM: tabele, listy zadań przez plugin, autolinki) + `shiki` (kolorowanie bloków kodu, motyw z tokenów dark/light) → HTML → `view.postMessage({ type: 'render', html, baseDir })`. Obserwacja pliku (`fs.watch` + debounce 150 ms) → ponowny render.
- Obrazy względne: backend zamienia `<img src="rel.png">` na `data:` URI (≤ 5 MB na obraz, ≤ 20 MB na dokument), większe → placeholder z nazwą.
- Widok: sanityzacja `DOMPurify` (mimo renderu w backendzie — obrona w głąb), wstrzyknięcie HTML, zachowanie proporcjonalnej pozycji scrolla po odświeżeniu, linki: `http(s)` → `openExternal`, względne `.md` → `openPanel('markdown.preview', { params: { path } })`, kotwice `#` → scroll.
- Tytuł panelu: nazwa pliku; badge „changed” przez 3 s po odświeżeniu.
- (Później) mermaid, KaTeX, synchronizacja scrolla z terminalem — poza MVP.

## 12. Wersjonowanie i kompatybilność

- `OXYTOCIN_API_VERSION` (semver). Do 1.0 zmiany łamiące dozwolone w minor (0.x) z wpisem w `packages/plugin-api/CHANGELOG.md`.
- Wtyczka z niespełnionym `engine` → `incompatible` (nie jest ładowana), komunikat z wymaganą wersją.
- SDK widoku negocjuje `sdkVersion` w handshake; powłoka wspiera bieżącą i poprzednią wersję protokołu.

## 13. Testy

- **Unit:** walidacja manifestu (poprawne/niepoprawne przypadki), rozwiązywanie konfliktów id, sprawdzanie `engine`, fabryka API (uprawnienia → `PermissionError`), `EnvironmentCollection` (scalanie, zakresy, `ready`, timeout), protokół `oxy-plugin://` (path traversal: `..%2F`, `%5C..`, ścieżki absolutne, symlinki poza root → 404).
- **Integration:** Plugin Host z wtyczką testową (`tests/fixtures/plugins/echo`) — aktywacja, polecenie, request/response widoku, crash w `activate`, zawieszenie pętli → wykrycie i restart.
- **E2E:** Markdown Preview otwarty z drzewa Zmian; edycja pliku w terminalu (`echo "# X" >> README.md`) → podgląd odświeżony < 1 s; przeniesienie panelu podglądu do innej grupy nie przeładowuje iframe'a; widok sidebara wtyczki testowej reaguje na zmianę motywu.

## 14. Kryteria akceptacji (M5)

- [ ] Wtyczka z samym widokiem (bez backendu) i wtyczka z backendem działają; manifest błędny → czytelny błąd w menedżerze.
- [ ] Widoki w slotach: sidebar (pane), panel centralny (dockview), pasek statusu (deklaratywny), polecenia w menu/skrótach.
- [ ] Iframe nie ma dostępu do `window.parent.oxy`, `fetch('https://…')` jest blokowany przez CSP (test E2E w wtyczce testowej).
- [ ] Wyjątek w `activate` jednej wtyczki nie wpływa na inne; crash Plugin Host → automatyczny restart i odtworzenie widoków.
- [ ] Wkład env wtyczki trafia do nowo tworzonych terminali; zmiana kolekcji oznacza istniejące terminale jako `envStale`.
- [ ] Markdown Preview spełnia §11 (render, obrazy, live reload, linki).
