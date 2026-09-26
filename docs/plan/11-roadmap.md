# 11 — Roadmapa, zadania i kryteria akceptacji

**Jak pracować z tym plikiem:** realizuj zadania po kolei (zależności podane przy zadaniu). Jedna sesja implementacyjna = zwykle 1–3 zadania. Po każdym zadaniu: DoD z [README §4](README.md), zaznacz `[x]`, wpis w „Dzienniku implementacji” (na końcu pliku, **po angielsku**). Cały kod, UI, komentarze, README i commity — po angielsku (ADR-018); licencja MIT (ADR-020). Rozmiary: **S** ≈ do 2 h pracy, **M** ≈ pół dnia, **L** ≈ dzień (jeśli L okazuje się większe — podziel i zaktualizuj plik).

## Przegląd kamieni milowych

| Kamień | Cel | Wynik widoczny dla użytkownika | Wersja |
|---|---|---|---|
| **M0** | Fundamenty i spike'i | Puste okno z układem z prototypu; pewność co do modułów natywnych | — |
| **M1** | Rdzeń terminala | Działający terminal (ConPTY) z pełną obsługą klawiatury i schowka | — |
| **M2** | Układ centralny | Taby, podziały, DnD, zapis układu | — |
| **M3** | Projekty i przełączanie | Lista projektów, statusy aktywności, przełączanie w locie, agenci wykrywani | — |
| **M4** | Zmiany i diff | Panel Zmian na żywo + diff względem HEAD | — |
| **M5** | Silnik wtyczek | Wtyczki w slotach + Markdown Preview | — |
| **M6** | Usage Monitor | Koszty i tokeny na żywo, budżety, dashboard | **v0.1 (MVP)** |
| **M7** | Dopracowanie UX | Paleta, skróty, ustawienia UI, motyw jasny, shell integration, wznawianie sesji | v0.2 |
| **M8** | Akcje Git | Discard/Stage/Commit, tryb Review | v0.2 |
| **M9** | Wydanie i ekosystem | Podpisy, auto-update, wtyczki zewnętrzne, szablon | v0.3 |

## Rejestr spike'ów

Wynik każdego spike'a: `docs/spikes/S<n>-<nazwa>.md` (co sprawdzono, wynik, decyzja, fragmenty kodu). Jeśli wynik zmienia decyzję — nowy ADR w [12](12-decisions-risks.md).

| ID | Pytanie | Kiedy | Status |
|---|---|---|---|
| S1 | node-pty 1.1.0 w `utilityProcess` Electron 44 na Windows (useConptyDll true/false) działa także **po spakowaniu** (asarUnpack, ścieżki conpty.dll/OpenConsole.exe)? | M0 | [x] Linux dev + packaged OK; Windows/ConPTY pending manual check ([S1](../spikes/S1-node-pty-utility-process.md)) |
| S2 | `node:sqlite` w `utilityProcess` i w `worker_threads` wewnątrz niego; WAL na Windows | M0 | [x] ([S2](../spikes/S2-node-sqlite.md)) |
| S3 | dockview-react 8.3 + xterm 6: `renderer: 'always'` — przeniesienie panelu nie resetuje xterm; iframe nie przeładowuje się przy DnD i przy reorderze Paneview; SerializeAddon odtwarza alt buffer (np. `vim`, Claude Code fullscreen) | M0 | [~] serialize part done; dockview part → M2-T2/M5-T3 E2E ([S3](../spikes/S3-dockview-xterm-serialize.md)) |
| S4 | `@parcel/watcher` w `utilityProcess` na Windows: repo z `node_modules`, `npm install` — liczba zdarzeń, CPU, ścieżki > 260 znaków | M0 | [x] Linux OK; Windows pending manual check ([S4](../spikes/S4-parcel-watcher.md)) |
| S5 | Rejestr sesji Claude Code: realne wartości `status`/`waitingFor` i czasy przejść; OSC 9;4 / tytuł / BEL emitowane przez Claude Code w xterm | M3 | [ ] |
| S6 | Dokładność Claude JSONL (po deduplikacji) vs OTEL `claude_code.token.usage`/`cost.usage` | M6 | [ ] |
| S7 | Codex rollouts i Gemini chats — aktualne schematy, `rate_limits`, `projectHash`, kodowanie OTLP `http` Gemini | M6 | [ ] |
| S8 | Monaco (editor.worker, codicon font) pod `app://` z CSP w buildzie produkcyjnym | M4 | [ ] |

---

## M0 — Fundamenty

- [x] **M0-T1 — Inicjalizacja repozytorium** (S)
  - `git init`, `.gitignore` (node_modules, out, release, dist, test-results, playwright-report, *.log, .DS_Store), `.editorconfig`, `.nvmrc` (24), `package.json` (nazwa `oxytocin`, `private: true`, `workspaces: ["packages/*", "plugins/*"]`, `type: "module"` jeśli electron-vite 5 tego wymaga — zweryfikować), `"license": "MIT"`), `LICENSE` z pełnym tekstem licencji MIT (`Copyright (c) 2026 <git config user.name>` — ADR-020), `README.md` **po angielsku** (opis produktu, status „work in progress”, wymagania: Windows 11 / Node 24 / git, komendy dev, sekcja „License: MIT”; link do `docs/plan/` z adnotacją, że dokumenty planu są po polsku).
  - Akceptacja: `npm install` działa na czystym klonie; `LICENSE` i `README.md` obecne, `package.json` ma `"license": "MIT"`.

- [x] **M0-T2 — Szkielet Electron + electron-vite** (M) · zależy: M0-T1
  - electron `~44.4.5`, electron-vite `~5.0.0`, vite `~7.3`, react/react-dom `~19.3`, @vitejs/plugin-react `~5.2`, typescript `~6.0.3`; `electron.vite.config.ts` z wejściami `index`, `ptyHost`, `workspaceHost`, `pluginHost` (stuby logujące start), preload, renderer (React „Hello”); tsconfigi (`tsconfig.node.json`, `tsconfig.web.json`, jawne `types`).
  - Skrypty: `dev`, `build`, `preview`, `typecheck`.
  - Akceptacja: `npm run dev` otwiera okno z HMR; `npm run build` tworzy `out/`; `npm run typecheck` zielony.

- [x] **M0-T3 — Narzędzia jakości** (M) · zależy: M0-T2
  - ESLint 10 flat + typescript-eslint 8.70 (typed) + react-hooks + reguły granic katalogów ([01 §3](01-architecture.md)); Prettier; Vitest 5 z projektami `unit-node`, `unit-web`, `integration`; Playwright z helperem `launchApp` i testem smoke (okno się otwiera, tytuł „Oxytocin”).
  - Licencje (ADR-020): skrypty `licenses:check` (`license-checker-rseidelsohn --production --onlyAllow …`) i `licenses:notices` (`scripts/generate-notices.ts` → `THIRD_PARTY_NOTICES.md`); `licenses:check` włączony do `check`.
  - Skrypty: `lint`, `format`, `test`, `e2e`, `check`, `licenses:check`, `licenses:notices`.
  - Akceptacja: `npm run check` i `npm run e2e` zielone lokalnie na Windows; `licenses:check` przechodzi dla bieżących zależności.

- [x] **M0-T4 — Bezpieczeństwo bazowe i protokoły** (M) · zależy: M0-T2
  - `webPreferences` wg [01 §5](01-architecture.md); `registerSchemesAsPrivileged` (`app`, `oxy-plugin`); handler `app://` serwujący `out/renderer` w prod (path traversal guard) + CSP; blokady nawigacji i `window.open`; handler uprawnień sesji; single instance lock; `--user-data-dir`/`OXYTOCIN_USER_DATA_DIR`.
  - Akceptacja: test unit handlera `app://` (traversal → 404); E2E: `window.oxy` istnieje, `require` nie istnieje w rendererze; build prod ładuje się z `app://`.

- [x] **M0-T5 — Fundament IPC/RPC i logowanie** (L) · zależy: M0-T4
  - `shared/ipc/contract.ts` + `events.ts` (na razie `app:getInfo`, `settings:get`), router z zod i `assertTrustedSender`, preload `window.oxy`, typowany klient renderera; `shared/rpc/port-rpc.ts` z adapterami; `main/hosts/utility-host.ts` (fork, restart z backoffem, ping); electron-log w main + przekazywanie logów z hostów; `OxyError`.
  - Akceptacja: unit testy `createPortRpc` (req/res, błędy, timeout, eventy) i routera (zła walidacja → błąd `INVALID`); E2E: renderer pobiera `app:getInfo` z wersjami Electron/Node; zabicie procesu hosta w teście → restart i log.

- [x] **M0-T6 — Spike'i S1–S4** (L) · zależy: M0-T5
  - Minimalne prototypy w gałęzi `spike/*` lub katalogu `spikes/` (usuwane po zakończeniu), wyniki w `docs/spikes/`. S1 obejmuje **spakowany build** (`electron-builder --win --dir`) z node-pty w PTY Host.
  - Akceptacja: 4 dokumenty wyników; ewentualne ADR-y korygujące.

- [x] **M0-T7 — Powłoka UI i design system** (L) · zależy: M0-T3
  - Tailwind v4 + `tokens.css` ([02 §3](02-ui-ux.md)), lokalne fonty Inter i JetBrains Mono, `TitleBar` (drag region, `titleBarOverlay`), `Sidebar` z `PaneviewReact` i trzema sekcjami-placeholderami (`PROJECTS`, `CHANGES`, `USAGE`) w stylu kart z prototypu, obszar centralny z placeholderem, `StatusBar`; prymitywy `ui/` (Button, IconButton, Badge, StatusDot z animacjami, Section, ProgressBar, SplitBar, Kbd, EmptyState, ConfirmDialog, Toast); wszystkie teksty po angielsku wg [02 §12–13](02-ui-ux.md) (bez frameworka i18n); licencje fontów (OFL) obok plików fontów.
  - Akceptacja: zrzut ekranu zbliżony do prototypu (układ, kolory, typografia); zmiana szerokości sidebara i zwijanie sekcji trwałe po restarcie (`ui-state.json`); komponenty mają testy jsdom.

- [x] **M0-T8 — CI** (S) · zależy: M0-T3
  - `.github/workflows/ci.yml` wg [10 §7](10-quality-testing-release.md) (może czekać na zdalne repo — plik gotowy).
  - Akceptacja: workflow poprawny składniowo (`actionlint`, jeśli dostępny), lokalnie `npm run check` = to samo, co CI.

- [x] **M0-T9 — CLAUDE.md** (S) · zależy: M0-T3
  - Utwórz `CLAUDE.md` z [claude-md-template.md](claude-md-template.md), uzupełnij rzeczywiste komendy.

---

## M1 — Rdzeń terminala

- [x] **M1-T1 — PTY Host: sesje, lustro, batching, flow control** (L) · zależy: M0-T5, S1
  - `pty-host/`: `TerminalSession`, `HeadlessMirror` (`@xterm/headless` + `SerializeAddon`), `DataBatcher` (5 ms/64 KB), `FlowController` (100k/5k, timeout 5 s), metody RPC `spawn/kill/list/serialize/shutdown/ping`, zdarzenia `exit/title/bell/progress/notification/activity` ([04 §3–4](04-terminals.md)).
  - Akceptacja: testy integracyjne w Node: spawn `node -e` → output; exit code; resize; snapshot → identyczny bufor w nowym headless; 20 MB bez utraty i z pauzą/wznowieniem; kill drzewa procesów.

- [ ] **M1-T2 — TerminalService, profile, env** (L) · zależy: M1-T1
  - Wykrywanie profili (Windows: pwsh, PowerShell, cmd, Git Bash, WSL z dekodowaniem UTF-16LE; POSIX: `$SHELL`, `/etc/shells`), `env-composer` (kolejność, czyszczenie markerów, `null`, case-insensitive Windows, `${env:NAME}`), `ShellEnvService` (macOS/Linux), rejestr `TerminalInfo`, IPC `terminals:*`, połączenie portu main ↔ PTY Host ↔ renderer (+ ponowne po reloadzie).
  - Akceptacja: unit testy env-composera i detekcji (mock FS/rejestru); E2E: `terminals:create` zwraca `TerminalInfo` z `pid`.

- [ ] **M1-T3 — TerminalView (xterm 6)** (L) · zależy: M1-T2
  - Fabryka xterm z ustawień i tokenów, addony (fit, unicode11, web-links, search, clipboard, progress; webgl tylko przy `terminal.renderer='webgl'`), protokół attach/snapshot/seq/ack, ResizeObserver + fit, `terminalRegistry`, tymczasowy panel pełnoekranowy w obszarze centralnym (przed M2).
  - Akceptacja: E2E: prompt widoczny, `echo` działa, kolory ANSI, reload renderera przywraca bufor, rozmiar dopasowuje się do okna.

- [ ] **M1-T4 — Klawiatura i schowek** (M) · zależy: M1-T3
  - `KeybindingService` (konteksty `when`, mapa domyślna z [02 §7](02-ui-ux.md)), `attachCustomKeyEventHandler`, Ctrl+C/V wg ustawień (w tym obraz w schowku → `\x16`), Ctrl+Shift+C/V, prawy przycisk (Windows copy/paste), Shift+Enter → `\x1b\r`, ostrzeżenie przy wklejaniu wielu linii, DnD plików → cytowane ścieżki per powłoka, polityka OSC 52.
  - Akceptacja: unit testy rozwiązywania skrótów i cytowania ścieżek; E2E: Ctrl+C przerywa proces, kopiowanie zaznaczenia, wklejanie.

- [ ] **M1-T5 — Chrome terminala** (M) · zależy: M1-T3
  - Widget wyszukiwania (Ctrl+Shift+F), tytuł z OSC, BEL → ikona, pasek „Process exited with code n” + restart/zamknij, menu kontekstowe, linki plików (ILinkProvider + `fs:statMany` + akcje), pasek postępu OSC 9;4.
  - Akceptacja: E2E: wyszukiwanie znajduje tekst; `exit 3` → pasek z kodem; Ctrl+klik na `package.json:1` otwiera edytor (mock `editor:open` w E2E).

---

## M2 — Układ centralny (dockview)

- [ ] **M2-T1 — Integracja DockviewReact** (L) · zależy: M1-T3, S3
  - `ProjectWorkspace` (na razie jeden, „domyślny” projekt = katalog domowy/tymczasowy), `panel-registry`, `TerminalPanel`, `OxyTab` (tytuł, badge rodzaju, StatusDot, close), `GroupActions`, `singleTabMode: 'fullwidth'`, `defaultRenderer: 'always'`, motyw `--dv-*`, przerywane separatory, fokus aktywnej grupy.
  - Akceptacja: wygląd zgodny z prototypem (dwa terminale jeden nad drugim, badge SHELL/PROCES).

- [ ] **M2-T2 — Operacje układu** (M) · zależy: M2-T1
  - Nowy terminal, podział w prawo/dół (ten sam profil/cwd), zamknięcie z potwierdzeniami, maksymalizacja, fokus/rozmiar skrótami, zmiana nazwy tabu, menu kontekstowe tabu, `oxy-dragging` dla iframe'ów, watermark z szybkimi akcjami.
  - Akceptacja: E2E z [05 §11](05-layout-center.md) (podziały, DnD bez utraty bufora).

- [ ] **M2-T3 — Serializacja i WorkspaceStateService** (M) · zależy: M2-T2
  - `WorkspaceState` ([03 §7](03-projects-workspace.md)), zapis debounce + flush, odtworzenie (`fromJSON`, podmiana `terminalId`, panel `missing`), snapshot scrollbacku przy wyjściu i odtworzenie z separatorem, `QuitGuard`.
  - Akceptacja: E2E restartu (układ + scrollback); uszkodzony plik → układ domyślny + toast.

---

## M3 — Projekty i przełączanie w locie

- [ ] **M3-T1 — ProjectService i IPC** (M) · zależy: M0-T5
  - Model, `projects.json` (atomowy zapis, migracje), walidacja/dedupe/odrzucenie zbyt szerokich folderów, `missing`, `findByPath`, `setActive`, argv + `second-instance`.
  - Akceptacja: unit testy (dedupe case-insensitive, zagnieżdżenia, brak folderu); E2E: dodanie przez argv.

- [ ] **M3-T2 — Sekcja Projekty (UI)** (M) · zależy: M3-T1, M0-T7
  - Lista z anatomią z [03 §4](03-projects-workspace.md), dodawanie (dialog, DnD przez `webUtils.getPathForFile`), zmiana nazwy inline, reorder DnD, przypinanie, menu kontekstowe, filtr, skróty Ctrl+Alt+1…9 / ↑↓, dialog usuwania z zabijaniem terminali.
  - Akceptacja: testy jsdom komponentu; E2E dodania przez DnD (symulacja) i usunięcia.

- [ ] **M3-T3 — Workspace'y per projekt (keep-alive + rehydratacja)** (L) · zależy: M3-T2, M2-T3
  - `WorkspaceHost` z LRU (`workspace.keepAliveProjects`), ukrywanie/pokazywanie, fokus ostatniego panelu, zwalnianie WebGL, rehydratacja po eviction, tytuł okna, pierwsze otwarcie → `startupTerminals` lub terminal domyślny.
  - Akceptacja: E2E scenariusze 4 i 5 z [10 §4](10-quality-testing-release.md); pomiar przełączenia < 150 ms na CI.

- [ ] **M3-T4 — Spike S5 + AgentService v1** (L) · zależy: M1-T1
  - Spike S5 (realny Claude Code). `ProcessMonitor` (windows-process-tree / ps, interwał adaptacyjny), reguły agentów, klasyfikacja `shell/process/agent`, watcher rejestru `~/.claude/sessions` (+ fallback `claude agents --json`), sygnały OSC/BEL/heurystyki, priorytety źródeł, `agents:updated`, badge na tabach.
  - Akceptacja: unit testy klasyfikacji na drzewach z fixture i mapowania statusów; E2E z fikcyjnym agentem ([10 §3.3](10-quality-testing-release.md)).

- [ ] **M3-T5 — Aktywność projektów i system uwagi** (M) · zależy: M3-T4, M3-T2
  - `deriveActivity`, „widziane” błędy, `projects:activity`, StatusDot na liście, `NotificationService` (toasty, powiadomienia OS z kliknięciem → projekt/terminal, `flashFrame`, overlay icon z liczbą czekających, prefiks tytułu), skrót „Jump to waiting agent” (Ctrl+Shift+J), ustawienia `notifications.*`.
  - Akceptacja: E2E scenariusz 8; unit testy `deriveActivity`.

- [ ] **M3-T6 — Przywracanie przy starcie i wyjście** (S) · zależy: M3-T3
  - Otwarcie ostatniego projektu, odtworzenie workspace'ów leniwie (tylko aktywny przy starcie; pozostałe przy pierwszym otwarciu — ale terminale projektów, które miały terminale, **nie** są tworzone w tle przy starcie, aby nie uruchamiać procesów bez wiedzy użytkownika), dialog wyjścia z listą procesów.
  - Akceptacja: E2E scenariusze 6 i 11.

---

## M4 — Zmiany i diff (Git)

- [ ] **M4-T1 — Workspace Host: RepoWatcher i scheduler** (L) · zależy: M0-T5, S4
  - `discover`, wykrywanie git i wersji, `@parcel/watcher` (drzewo + katalog git, ignorowane foldery), `RefreshScheduler` (debounce 250/maxWait 1000, single-flight, adaptacja, priorytet aktywnego), `git:fileTouched`, start/stop watcherów wg aktywności projektów (`GitService` w main).
  - Akceptacja: unit testy schedulera (fake timers); integracja: zapis pliku → żądanie odświeżenia < 300 ms.

- [ ] **M4-T2 — Status względem HEAD** (L) · zależy: M4-T1
  - `exec.ts` (`--no-optional-locks`, env, timeouty, limity), parser porcelain v2 (`-z`), numstat, liczenie linii untracked, `statusVsHead`, pathspec dla monorepo, `RepoStatus`, emisja przy zmianie hash.
  - Akceptacja: wszystkie testy unit/integration z [06 §10](06-git-changes.md), w tym CRLF i `index.lock`.

- [ ] **M4-T3 — Sekcja Zmiany (UI)** (L) · zależy: M4-T2, M0-T7
  - Nagłówek (gałąź, ahead/behind, SplitBar, sumy), wirtualizowane drzewo z kompaktowaniem, tryb listy, filtr, podświetlenia „na żywo”, klawiatura, menu kontekstowe, stany puste, stan per projekt w `WorkspaceState.ui`.
  - Akceptacja: testy jsdom (budowa drzewa, nawigacja); E2E scenariusz 7 (część listy).

- [ ] **M4-T4 — Spike S8 + panel diffu (Monaco)** (L) · zależy: M4-T2, M2-T1
  - Lokalny Monaco (editor.api + basic-languages + editor.worker), motyw z tokenów, `git:getFileDiff` (`cat-file --filters`, binarne, za duże, usunięte/nowe), `DiffPanel` z paskiem narzędzi, preview tabs, aktualizacja na żywo z zachowaniem viewState, F7/Shift+F7.
  - Akceptacja: E2E scenariusz 7 (diff); diff pliku z CRLF bez fałszywych zmian; działa w buildzie prod pod `app://`.

- [ ] **M4-T5 — „Open in editor”** (S) · zależy: M3-T1
  - `EditorLauncher` z presetami i `auto`, bezpieczne argv (także `.cmd` na Windows), preset `terminal` (nowy panel terminala z komendą), polecenie w menu Zmian, diffu i linków terminala.
  - Akceptacja: unit testy parsera szablonu i cytowania dla cmd.

---

## M5 — Silnik wtyczek

- [ ] **M5-T1 — Manifest, odkrywanie, stany** (M) · zależy: M0-T5
  - `PluginManifestSchema` (zod), discovery (builtin/user/dev), konflikty id, `engine` (semver), `plugins.enabled`, `PluginDescriptor`, rejestr kontrybucji, IPC `plugins:*`.
  - Akceptacja: unit testy z [07 §13](07-plugin-engine.md) (manifest, konflikty, engine).

- [ ] **M5-T2 — Plugin Host i API backendu** (L) · zależy: M5-T1
  - Loader (`import()`), zdarzenia aktywacji, `PluginContext`, fabryka API (`projects`, `terminals`, `agents`, `git`, `ui`, `commands`, `settings`, `storage`, `log`) z uprawnieniami, izolacja błędów, wykrywanie zawieszeń, restart, deaktywacja; pakiet `packages/plugin-api` (d.ts z [07 §6.4](07-plugin-engine.md)).
  - Akceptacja: testy integracyjne z wtyczkami testowymi (`echo`, `crash-on-activate`, `hang`).

- [ ] **M5-T3 — Widoki: protokół, iframe, most** (L) · zależy: M5-T2
  - `oxy-plugin://` (guard, CSP, nagłówki), `PluginFrame`, handshake z `MessageChannel`, `ViewBridge` (wiadomości powłokowe + routing do hosta), limity rozmiaru/częstotliwości, stan widoków, widoczność, motyw, przekazywanie klawiszy, nakładki ładowania/błędu; pakiet `packages/plugin-sdk` (`connect()`, `theme.css`, helpery React).
  - Akceptacja: E2E: wtyczka testowa z widokiem odbiera/wysyła wiadomości, `fetch` zablokowany, `window.parent.oxy` niedostępne, przeniesienie panelu nie przeładowuje iframe'a.

- [ ] **M5-T4 — Sloty i kontrybucje** (L) · zależy: M5-T3, M2-T1
  - Sidebar (panes wtyczek w Paneview wg `order`), panele centralne (typ `plugin` w dockview, `singleton`, deskryptory ze stanem), status bar (deklaratywny), polecenia (rejestr rdzenia + aktywacja `onCommand`), `configuration` (walidacja, prefiksy), `fileOpeners` (menu Zmian, linki terminala), `EnvironmentCollection` (zakresy, `${env:}`, `ready()`, blokada startowa 2 s, `envStale`), `terminalProfiles`, `agents`.
  - Akceptacja: E2E: element status bara aktualizowany z backendu; env wtyczki widoczne w nowym terminalu (`echo $env:X` / `echo $X`), istniejący terminal oznaczony ⟳.

- [ ] **M5-T5 — Build wtyczek wbudowanych** (S) · zależy: M5-T3
  - `scripts/build-plugins.ts` (Vite dla widoków, bundel ESM hosta), integracja z `npm run build` i `electron-builder` (`extraResources`), sumy SHA-256 wtyczek wbudowanych.
  - Akceptacja: spakowana aplikacja ładuje wtyczki z `resources/plugins`.

- [ ] **M5-T6 — Markdown Preview** (M) · zależy: M5-T4, M5-T5
  - Wg [07 §11](07-plugin-engine.md).
  - Akceptacja: E2E z [07 §13](07-plugin-engine.md).

- [ ] **M5-T7 — Minimalny menedżer wtyczek** (S) · zależy: M5-T4
  - Panel „Plugins”: lista, stan, włącz/wyłącz, przeładuj, logi, folder; tryb dev: załaduj z folderu + auto-reload.
  - Akceptacja: wyłączenie wtyczki usuwa jej widoki, status bar i env (terminale → `envStale`).

---

## M6 — Usage Monitor (→ v0.1 MVP)

- [ ] **M6-T1 — Spike'i S6 i S7 + fixtures** (M) · zależy: M5-T2
  - Wyniki w `docs/spikes/`; zanonimizowane fixture'y + `expected.json`; skrypt `make-fixtures.ts`.

- [ ] **M6-T2 — Szkielet wtyczki, worker, baza, cennik** (L) · zależy: M6-T1
  - Manifest, `ingest-worker` z `node:sqlite` (migracje 001), `scripts/update-pricing.ts` + snapshot, `PricingService` (snapshot/cache/overrides, odświeżanie 24 h z ETag), normalizacja modeli, `computeCost` + tryby kosztu.
  - Akceptacja: unit testy kosztów (złote wartości z [08 §18](08-usage-monitor.md)) i normalizacji.

- [ ] **M6-T3 — Collector Claude JSONL + atrybucja** (L) · zależy: M6-T2
  - Tailer (kursory, obcięcia, niepełne linie, szybka ścieżka), parser, upsert z max, backfill z postępem, atrybucja projektu (cwd) i terminala (`oxy.agents`), tabela `sessions`.
  - Akceptacja: sumy z fixture = `expected.json`; dopisanie linii → zdarzenie w ≤ 1 s (integration).

- [ ] **M6-T4 — Collectory Codex i Gemini** (M) · zależy: M6-T3
  - Wg [08 §7–8](08-usage-monitor.md), w tym delty sum Codex, `rate_limits` → `agent_limits`, `projectHash` Gemini, korelacja terminali + `reportSession`.
  - Akceptacja: sumy z fixture = `expected.json`.

- [ ] **M6-T5 — Odbiornik OTLP (opt-in)** (M) · zależy: M6-T3, M5-T4
  - Serwer 127.0.0.1 z tokenem, JSON (+ gzip; protobuf jeśli S7 wymaga), mapowanie metryk Claude/Gemini, zasada „jedno źródło na sesję”, wstrzykiwanie env z `profileIds`, ochrona przed konfliktem z konfiguracją użytkownika.
  - Akceptacja: testy integracyjne z przykładowymi payloadami; brak podwójnego liczenia przy obu źródłach.

- [ ] **M6-T6 — Agregacje, sesje na żywo, budżety** (M) · zależy: M6-T3
  - Zapytania, burn rate, projekcje, bloki 5h, budżety + progi + powiadomienia, wybór paska „% limitu”.
  - Akceptacja: unit testy bloków 5h i progów (fake time).

- [ ] **M6-T7 — UI: sidebar, status bar, dashboard** (L) · zależy: M6-T6, M5-T4
  - Widok sidebara (prototyp), element status bara, dashboard (5 zakładek, uPlot), ustawienia wtyczki.
  - Akceptacja: E2E scenariusz 10; wygląd karty zgodny z prototypem.

- [ ] **M6-T8 — Stabilizacja MVP i wydanie v0.1** (M) · zależy: wszystkie powyżej
  - Przegląd budżetów wydajności, packaged smoke (Windows NSIS), ręczny test z prawdziwym Claude Code, okno „About” (wersja + licencja MIT) i „Help → Third-Party Notices”, aktualny `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md` (po angielsku), tag `v0.1.0`.

---

## M7 — Dopracowanie UX (v0.2)

- [ ] **M7-T1 — Paleta poleceń i Quick Open** (M) — [02 §8](02-ui-ux.md).
- [ ] **M7-T2 — `keybindings.json` i edytor skrótów** (M) — nadpisania użytkownika, wykrywanie konfliktów.
- [ ] **M7-T3 — UI ustawień** (L) — formularze generowane ze schematów rdzenia i wtyczek, wyszukiwarka, „Open settings.json”, problemy z ustawieniami.
- [ ] **M7-T4 — Motyw jasny i `system`** (M) — tokeny light, xterm/Monaco/dockview, `titleBarOverlay`.
- [ ] **M7-T5 — Shell integration** (L) — skrypty pwsh/bash/zsh/fish, OSC 633, cwd, granice komend, powiadomienia o długich komendach, `initialCommand` po promptcie ([04 §11](04-terminals.md)).
- [ ] **M7-T6 — Wznawianie sesji agentów** (M) — pasek „Resume session” po restarcie (`claude --resume <id>`, `codex resume <id>`, `gemini --resume`), nigdy automatycznie.
- [ ] **M7-T7 — Ustawienia projektu (UI)** (M) — [03 §8](03-projects-workspace.md), zadania startowe.
- [ ] **M7-T8 — xterm 6.1 / kitty keyboard** (S) — po wydaniu 6.1: `vtExtensions.kittyKeyboard`, wyłączenie mapowania Shift+Enter, gdy aplikacja włączy protokół.
- [ ] **M7-T9 — Floating groups i polish układu** (S).

## M8 — Akcje Git (v0.2)

- [ ] **M8-T1 — Discard** (M) — plik/rename/wszystko, kopie zapasowe + „Undo”, nieśledzone do Kosza ([06 §8](06-git-changes.md)).
- [ ] **M8-T2 — Stage/Unstage i Commit** (M) — dialog commita, obsługa błędów hooków, `git init`.
- [ ] **M8-T3 — Tryb Review** (L) — wszystkie diffy w jednym widoku, „reviewed”.

## M9 — Wydanie i ekosystem (v0.3)

- [ ] **M9-T1 — Podpisywanie (Windows/macOS) i notaryzacja** (M).
- [ ] **M9-T2 — Auto-update** (M) — [10 §9](10-quality-testing-release.md), z `QuitGuard`.
- [ ] **M9-T3 — Wtyczki użytkownika** (L) — instalacja z folderu/zip, dialog zgody, `userData/plugins`, osobny Plugin Host dla zewnętrznych (ADR).
- [ ] **M9-T4 — `create-oxytocin-plugin` + dokumentacja dla twórców** (M).
- [ ] **M9-T5 — Wtyczka „Claude Code Bridge”** (L) — hooki `http` (`Notification`, `Stop`, `SessionStart`) kierowane na lokalny endpoint z tokenem z env `OXYTOCIN_*`; instalowana jako plugin Claude Code za zgodą; stan agenta ze źródła `hook` (najwyższy priorytet).

## Backlog (bez przypisania)

- Checkpointy git przed uruchomieniem agenta ([06 §8](06-git-changes.md)).
- Serwer MCP „oxytocin” (agent może otworzyć podgląd/diff w Oxytocin, odczytać listę zmian, wysłać powiadomienie).
- Projekty WSL/SSH (git i watcher po stronie zdalnej).
- Wiele okien (projekt w osobnym oknie).
- Tryb „detached PTY daemon” — procesy przeżywają zamknięcie aplikacji (wymaga osobnego procesu tła i protokołu reconnect).
- Parser outputu dla Aider/innych agentów w Usage Monitorze.
- Tabela dziennych agregatów Usage (jeśli wydajność tego wymaga).
- Porównanie agentów („ten sam prompt w Claude/Codex/Gemini”).

---

## Dziennik implementacji

> Format (entries in English): `YYYY-MM-DD · task ID · short summary · deviations from the plan · known gaps`

- 2026-09-26 · M0-T1 · Repository initialized: `.gitignore`, `.editorconfig`, `.nvmrc` (24), root `package.json` (npm workspaces, MIT), `LICENSE` (MIT, © Jakub Konkol — the repo owner; `git config user.name` in the session was a bot identity), English `README.md`. · `"type": "module"` intentionally not set: electron-vite 5 then emits CommonJS for main/preload/hosts, which a sandboxed preload requires. · —
- 2026-09-26 · M0-T2 · Electron 44.4.5 + electron-vite 5.0.0 + Vite 7.3 + React 19.3 + TS 6.0.3 skeleton; main forks three stub utility processes (`ptyHost`, `workspaceHost`, `pluginHost` as extra `rollupOptions.input` entries); `tsconfig.base.json` shared by node/web configs with explicit `types`. · `build.externalizeDeps` (default on) used instead of the deprecated `externalizeDepsPlugin`. npm 11 blocks install scripts by default, so `allowScripts` in `package.json` whitelists the packages that need them. · Running as root (containers) requires `--no-sandbox`.
- 2026-09-26 · M0-T3 · ESLint 10 flat config (typescript-eslint 8.70 recommendedTypeChecked, react-hooks 7, directory boundaries via `no-restricted-imports`, no color literals in TSX, no `console`), Prettier, Vitest 5 projects `unit-node`/`unit-web`/`integration`, Playwright with `launchApp` + smoke test, `licenses:check` and `licenses:notices` (generates `THIRD_PARTY_NOTICES.md`). First shared utilities: `Disposable`/`DisposableStore`, `Emitter`. · `npm run e2e` builds first; on Linux the helper passes `--no-sandbox` and tests run under `xvfb-run -a`. `tsconfig.tools.json` covers tests, scripts and tool configs. · E2E verified on Linux only (no Windows machine in this session).
- 2026-09-26 · M0-T4 · Security baseline: sandboxed `webPreferences`, privileged `app`/`oxy-plugin` schemes, `app://oxytocin` static handler with traversal guard and CSP header (plus a CSP meta tag injected by a Vite plugin; dev variant allows HMR), navigation/`window.open`/webview blocking, deny-all permission handlers, single-instance lock, `--user-data-dir`/`OXYTOCIN_USER_DATA_DIR`. · The userData override is applied with `app.setPath` before the single-instance lock (the lock is per userData dir, so E2E profiles run in parallel). · —
- 2026-09-26 · M0-T5 · IPC contract (`app:getInfo`, `app:getHostStatus`, `settings:get`; events `settings:changed`, `hosts:status`) with a zod-validating router and `assertTrustedSender`, preload `window.oxy` with channel allowlists, typed renderer client; `createPortRpc` + adapters + `startHostRuntime`; `UtilityHost` supervisor (backoff restart, restart limit, ping health checks, events survive restarts); electron-log (5 MB × 3 rotation) with host log forwarding; `OxyError`; `JsonFileStore`/atomic writes; `SettingsService` (JSONC, per-key validation, unknown keys kept, file watch). · Decisions: OxyError gained `TIMEOUT`, `UNAVAILABLE` and `CANCELLED` codes; errors cross `ipcMain.handle` encoded in the message (`OXY_ERROR:{json}`) because Electron only keeps `message`; settings are a flat dotted-key object (`settings['terminal.fontSize']`) instead of a nested one — simpler typing and 1:1 with settings.json; channel names live in a zod-free `channels.ts` so the preload bundle stays small; Node's `URL` gives `app://` an opaque origin, so trust checks compare protocol + host. Test hooks are exposed on `globalThis.__oxyMain` only when `OXYTOCIN_E2E=1`. · Settings are read-only until the settings UI (M7).
- 2026-09-26 · M0-T6 · Spikes S1–S4 run in real Electron 44 utility processes on Linux (dev and packaged `linux-unpacked`); reports in `docs/spikes/`. node-pty, node:sqlite (WAL, worker thread) and @parcel/watcher work; SerializeAddon restores the alternate buffer but not cursor visibility and SGR mouse encoding (the mirror will append them). Added runtime deps node-pty, @xterm/headless, @xterm/addon-serialize, @parcel/watcher and dev deps electron-builder, @electron/fuses. · Blocked parts: no Windows 11 machine in this session, so ConPTY/`useConptyDll`, the packaged Windows build and the Windows watcher backend remain unverified (flagged in S1/S4 and moved to the packaged smoke test before v0.1). The dockview half of S3 is covered by the M2-T2 and M5-T3 E2E tests instead of a throwaway prototype. · No ADR changes.
- 2026-09-26 · M0-T7 · UI shell: Tailwind v4 with `@theme inline` utilities backed by `tokens.css` (Oxytocin Dark + ANSI palette), dockview theme `dockview-theme-oxytocin`, `TitleBar` (drag region, `titleBarOverlay` on Windows/Linux, `hiddenInset` on macOS), sidebar `PaneviewReact` with PROJECTS/CHANGES/USAGE placeholder cards, resizable/collapsible sidebar, center welcome placeholder, `StatusBar`; primitives Button, IconButton, Tooltip, Badge, StatusDot (animations, reduced motion), SectionHeader/SectionBody, ProgressBar, SplitBar, Kbd, EmptyState, ConfirmDialog (Radix AlertDialog), Toast (sonner). `UiStateService` persists `ui-state.json` (sidebar, Paneview order/sizes/collapsed, window bounds with off-screen recovery) via `ui:getState`/`ui:patchState`. Screenshot: `docs/screenshots/m0-t7-shell.png`. · Fonts come from the `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` npm packages (OFL-1.1, bundled locally by Vite) instead of vendored files, so the license check and THIRD_PARTY_NOTICES cover them automatically. Ctrl+Shift+B is a temporary window listener until the KeybindingService (M1-T4). Animations are disabled when `OXYTOCIN_E2E=1`. · Sections contain placeholders only; no unfinished actions are exposed.
- 2026-09-26 · M0-T8 · `.github/workflows/ci.yml`: `check` job on Windows/Ubuntu/macOS (typecheck, lint, license check on Ubuntu, unit-node + unit-web, integration) and `e2e` job on Windows/Ubuntu (Ubuntu under `xvfb-run`, Playwright system deps installed), failure artifacts uploaded. Validated with actionlint 1.7.12. · Node version comes from `.nvmrc`; runs on pushes to main and on PRs (the remote repository already exists, so CI is live). · —
- 2026-09-26 · M0-T9 · `CLAUDE.md` created from the template with the real commands, environment notes for Linux/cloud sessions (xvfb, `--no-sandbox`, Electron download workaround, npm `allowScripts`) and the owner's mandatory working rules (work on main, commit only green states, tick + journal + push per task, no unfinished features in visible UI — use `OXYTOCIN_EXPERIMENTAL=1`, handling blocked tasks, autonomy, commit authorship without trailers). · The template's "do not push unless asked" was replaced by the owner's rule to push after every task. · —
- 2026-09-26 · M1-T1 · PTY Host: `TerminalSession` (node-pty + `HeadlessMirror` + `DataBatcher` 5 ms/64 KB + `FlowController` 100k/5k with 5 s ACK timeout, seq numbers, gap-free attach: flush → parse barrier → snapshot → queued data), OSC handlers (title throttled 250 ms, BEL 1 s, OSC 9/9;4/777/7), `TerminalManager` with renderer connections over MessagePorts, RPC `spawn/write/resize/kill/dispose/list/serialize/setScrollback/shutdown/ping`, process-tree kill (taskkill /T /F or ps + SIGKILL). Integration tests with real node-pty: output, exit code, resize, snapshot rebuild, gap-free streaming, 20 MB with pause/resume and SHA-256 check, tree kill. · Added `write`/`resize`/`dispose` RPC methods beyond the plan (main-driven input for initial commands, releasing exited mirrors). With several renderer subscribers flow control counts every ACK against one counter (one window in v0.1). `tsconfig.tools.json` now includes Node-side sources so tests can import them. · Process monitor (`terminal:process`) comes with M3-T4.
