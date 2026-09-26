# Oxytocin — kompletny plan projektu i implementacji

> **Status:** Plan v1.0 · 2026-09-26 · przygotowany do realizacji w kolejnych sesjach Claude Code.
> **Produkt:** Oxytocin — „IDE dla terminala i AI”: desktopowy hub (Electron + TypeScript) organizujący projekty, terminale z agentami AI, podgląd zmian w kodzie (git diff względem HEAD) oraz koszty API. Nie jest edytorem kodu.

Prototyp UI: [`../../ui_prototype.png`](../../ui_prototype.png) (omówiony w [02-ui-ux.md](02-ui-ux.md)).

---

## 1. Jak korzystać z tego planu (instrukcja dla sesji implementacyjnej)

1. **Zawsze zacznij od tego pliku**, potem przeczytaj [00-vision-and-scope.md](00-vision-and-scope.md) i [01-architecture.md](01-architecture.md). To kontekst obowiązkowy.
2. Otwórz [11-roadmap.md](11-roadmap.md), znajdź **pierwsze niezaznaczone zadanie** (np. `M1-T3`) i przeczytaj dokument domenowy, do którego ono linkuje.
3. Decyzje architektoniczne są w [12-decisions-risks.md](12-decisions-risks.md) (ADR). **Nie zmieniaj decyzji po cichu** — jeśli rzeczywistość (np. wynik spike'a) wymusza zmianę, dopisz nowy ADR ze statusem „Supersedes ADR-00X” i zaktualizuj dotknięte dokumenty.
4. Po ukończeniu zadania: spełnij „Definition of Done” (sekcja 4), zaznacz checkbox w roadmapie i dopisz 1–3 zdania do „Dziennika implementacji” na końcu [11-roadmap.md](11-roadmap.md) (co zrobiono, odstępstwa od planu, znane braki).
5. W fazie M0 utwórz w repo `CLAUDE.md` na podstawie [claude-md-template.md](claude-md-template.md).
6. Wersje bibliotek w tym planie zweryfikowano 2026-09-26. Jeśli implementacja zaczyna się dużo później, sprawdź `npm view <pkg> version` i peer dependencies (szczególnie electron-vite ↔ vite oraz typescript-eslint ↔ typescript) zanim podbijesz wersje.
7. **Język: angielski** (ADR-018). Po angielsku jest wszystko, co powstaje w repozytorium i w aplikacji: interfejs użytkownika, `README.md`, `CHANGELOG.md`, komentarze w kodzie, identyfikatory, komunikaty logów i błędów, nazwy testów, commity, wyniki spike'ów i wpisy w dzienniku. Brak frameworka i18n. Dokumenty tego planu są po polsku — polskie teksty UI oraz komentarze w szkicach kodu w planie są opisem intencji: w kodzie używaj angielskich odpowiedników (kanoniczne etykiety: [02 §13](02-ui-ux.md)).
8. **Licencja: MIT** (ADR-020) — `LICENSE` w katalogu głównym, `"license": "MIT"` w każdym `package.json`, zależności tylko z licencjami zgodnymi z MIT (kontrola `npm run licenses:check`), atrybucje w `THIRD_PARTY_NOTICES.md`.

## 2. Spis dokumentów

| Plik | Zawartość |
|---|---|
| [00-vision-and-scope.md](00-vision-and-scope.md) | Wizja, zasady produktowe, zakres MVP / później / non-goals, słownik, mapa wymagań → dokumenty |
| [01-architecture.md](01-architecture.md) | Stack i wersje, model procesów Electron, struktura katalogów, IPC, bezpieczeństwo, start/stop, obsługa błędów, logowanie, konwencje kodu |
| [02-ui-ux.md](02-ui-ux.md) | Analiza prototypu, układ ekranu, design tokens, komponenty, stany i animacje, skróty klawiszowe, paleta poleceń, powiadomienia, a11y, język UI (angielski) i kanoniczne etykiety |
| [03-projects-workspace.md](03-projects-workspace.md) | Domena 1: projekty, wskaźniki aktywności, przełączanie w locie (keep-alive + rehydratacja), przywracanie po restarcie |
| [04-terminals.md](04-terminals.md) | Domena 3: PTY Host (node-pty + xterm headless), protokół danych, flow control, xterm.js w rendererze, klawiatura, linki, wykrywanie agentów AI, shell integration |
| [05-layout-center.md](05-layout-center.md) | Obszar centralny: dockview, typy paneli, podziały, serializacja układu per projekt, panele pluginów |
| [06-git-changes.md](06-git-changes.md) | Domena 2: watcher, `git status` porcelain v2, drzewo zmian, diff względem HEAD (Monaco), akcje Discard/Commit |
| [07-plugin-engine.md](07-plugin-engine.md) | Domena 4: manifest, Plugin Host, API (d.ts), widoki w iframe (`oxy-plugin://`), sloty, uprawnienia, SDK, wbudowany Markdown Preview |
| [08-usage-monitor.md](08-usage-monitor.md) | Wbudowany plugin Usage Monitor: źródła danych (JSONL, rejestr sesji, OTLP), cennik, SQLite, budżety, UI |
| [09-persistence-settings.md](09-persistence-settings.md) | Układ `userData`, formaty plików, schemat ustawień, migracje, retencja |
| [10-quality-testing-release.md](10-quality-testing-release.md) | Strategia testów, fixtures, E2E, budżety wydajności, CI, pakowanie, aktualizacje |
| [11-roadmap.md](11-roadmap.md) | Kamienie milowe M0–M9, zadania z kryteriami akceptacji, spike'i, dziennik implementacji |
| [12-decisions-risks.md](12-decisions-risks.md) | ADR-y, rejestr ryzyk, otwarte pytania z przyjętymi założeniami |
| [claude-md-template.md](claude-md-template.md) | Szablon `CLAUDE.md` do skopiowania do katalogu głównego repo w M0 |

## 3. Streszczenie architektury (TL;DR)

- **Electron 44 + TypeScript 6.0 + React 19**, build: **electron-vite 5 (Vite 7)**, pakowanie: **electron-builder 26**. **Licencja MIT**, **całość po angielsku** (UI, README, komentarze, commity).
- **5 rodzajów procesów:** Main (orkiestrator) · **PTY Host** (utilityProcess: node-pty + `@xterm/headless` jako lustro bufora) · **Workspace Host** (utilityProcess: `@parcel/watcher` + git CLI) · **Plugin Host** (utilityProcess: backendy wtyczek) · Renderer (UI powłoki; widoki wtyczek w sandboxowanych `<iframe>` z protokołu `oxy-plugin://`).
- **Dane terminala płyną bezpośrednio** Renderer ⇄ PTY Host przez `MessagePort` (z pominięciem main), z sekwencjonowaniem, batchowaniem i flow control opartym o ACK.
- **Persystencja sesji:** procesy żyją w PTY Host niezależnie od UI; bufor jest lustrzany w `@xterm/headless`, więc widok można zniszczyć i odtworzyć (snapshot + dalszy strumień) bez utraty treści. Przełączanie projektów = ukrycie/pokazanie zamontowanych workspace'ów (LRU), a po wyrzuceniu z LRU — rehydratacja ze snapshotu.
- **Układ centralny:** `dockview-react` 8 (taby, podziały, drag&drop, serializacja; `renderer: 'always'` dla xterm/iframe). Lewy sidebar: Paneview z sekcjami Projekty / Zmiany / sloty wtyczek.
- **Git:** systemowy `git` wywoływany z `--no-optional-locks`, `status --porcelain=v2 -z`, `diff HEAD --numstat -z`, treść bazowa przez `git cat-file --filters HEAD:<path>` (poprawne CRLF). Diff renderowany w **Monaco DiffEditor** (tylko do odczytu).
- **Wykrywanie agentów AI:** drzewo procesów terminala (`@vscode/windows-process-tree` / `ps`) + reguły nazw + **rejestr sesji Claude Code `~/.claude/sessions/<pid>.json`** (status `busy`/`idle`/…) + sygnały OSC (tytuł, progress `OSC 9;4`, BEL).
- **Usage Monitor** (wbudowana wtyczka, dogfooding API): domyślnie czyta **lokalne logi agentów** (Claude Code JSONL, Codex rollouts, Gemini CLI chats), opcjonalnie odbiera **OTLP** (wstrzyknięte zmienne środowiskowe). Koszty liczone z cennika LiteLLM (snapshot + odświeżanie), dane w **`node:sqlite`**.

## 4. Globalna „Definition of Done” (dla każdego zadania)

- [ ] `npm run typecheck`, `npm run lint`, `npm test` przechodzą bez błędów i bez nowych ostrzeżeń.
- [ ] Nowa logika domenowa ma testy jednostkowe; nowa funkcja widoczna dla użytkownika ma co najmniej jeden scenariusz E2E (Playwright) lub uzasadnienie w dzienniku, dlaczego nie.
- [ ] Brak `any` bez komentarza uzasadniającego; wszystkie dane przychodzące przez IPC walidowane `zod` po stronie odbiorcy w main/hostach.
- [ ] Wszystko po angielsku: teksty UI (zgodne z [02 §13](02-ui-ux.md)), komentarze, identyfikatory, komunikaty logów/błędów, nazwy testów, commity.
- [ ] Nowe zależności mają licencję zgodną z MIT (`npm run licenses:check` zielony).
- [ ] Działa na Windows 11 (platforma główna). Kod platformowo-zależny ma gałęzie dla macOS/Linux (nawet jeśli nieprzetestowane ręcznie — wtedy CI).
- [ ] Zaktualizowany checkbox i dziennik w [11-roadmap.md](11-roadmap.md); jeśli zmieniono decyzję — nowy ADR.
- [ ] Commity: małe, opisowe, **bez trailerów `Co-Authored-By` i stopki „Generated with Claude Code”** (preferencja właściciela repo).

## 5. Zweryfikowane fakty (research z 2026-09-26)

### 5.1 Wersje (npm, stan na 2026-09-26)

| Pakiet | Wersja | Uwagi |
|---|---|---|
| `electron` | 44.4.5 | Node 24.21.0 (sprawdzone uruchomieniowo). Electron 45 stable planowany na 2026-10-20. |
| `electron-vite` | 5.0.0 | peer: `vite ^5 \|\| ^6 \|\| ^7` → **używamy Vite 7.3.x, nie 8** (6.0.0-beta istnieje). |
| `vite` | 7.3.6 (linia 7) | Vite 8.3 istnieje, ale nie jest wspierany przez electron-vite 5. |
| `typescript` | **6.0.3** | TS 7.0.2 (natywny) jest `latest`, ale `typescript-eslint` 8.70 wymaga `<6.1.0`. |
| `typescript-eslint` / `eslint` | 8.70.1 / 10.11 | flat config. |
| `react` / `react-dom` | 19.3.0 | |
| `@vitejs/plugin-react` | 5.2.0 | wspiera vite 4–8. |
| `node-pty` | 1.1.0 | Prebuildy **win32-x64/arm64 i darwin** w paczce + dołączony `conpty.dll` 1.23 i `OpenConsole.exe` (opcja `useConptyDll`). Linux wymaga kompilacji (lub 1.2.0-beta.15 z prebuildami linux). |
| `@xterm/xterm`, `@xterm/headless` | 6.0.0 | Renderer canvas usunięty (DOM lub WebGL). Wspiera synchronized output, OSC 52. Kitty keyboard protocol trafi w 6.1. |
| `@xterm/addon-*` | fit 0.11, webgl 0.19, serialize 0.14, search 0.16, unicode11 0.9, web-links 0.12, clipboard 0.2, progress 0.2, image 0.9 | |
| `dockview-react` | 8.3.1 | Zawiera DockviewReact, PaneviewReact, SplitviewReact, GridviewReact. iframy wymagają `renderer: 'always'`. |
| `@parcel/watcher` | 2.6.0 | natywny watcher (VS Code). |
| `@vscode/windows-process-tree` | 0.8.0 | szybkie drzewo procesów na Windows (prebuilt `.node`). |
| `monaco-editor` / `@monaco-editor/react` | 0.57.0 / 4.7.0 | |
| `zustand` | 5.0.15 | |
| `zod` | 4.6.5 | |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.3 | |
| `radix-ui` | 1.6.7 | prymitywy UI (menu, dialog, tooltip). |
| `cmdk` | 1.1.1 | paleta poleceń. |
| `@tanstack/react-virtual` | 3.14.13 | wirtualizacja drzewa zmian. |
| `sonner` | 2.0.8 | toasty. |
| `vitest` | 5.0.2 | peer vite 6.4–8. |
| `@playwright/test` | 1.63.0 | `_electron.launch()` do E2E. |
| `electron-builder` / `electron-updater` | 26.15.3 / 6.8.9 | |
| `@electron/fuses` | 2.1.3 | |
| `electron-log` | 5.4.4 | |
| `markdown-it` / `dompurify` / `shiki` | 15.0 / 3.4 / 4.4 | dla wtyczki Markdown Preview. |
| `uplot` | 1.6.32 | wykresy w dashboardzie Usage Monitor. |
| `better-sqlite3` | 13.0.3 | **tylko fallback** — `node:sqlite` działa w Electron 44. |

### 5.2 Fakty sprawdzone empirycznie na maszynie docelowej (Windows 11, Node 24.11, git 2.52)

- `ELECTRON_RUN_AS_NODE=1 electron.exe` (44.4.5): `require('node:sqlite')` → **działa** (`DatabaseSync`, in-memory insert/select OK).
- `node-pty@1.1.0` pod Electron 44 z `useConptyDll: true` → **działa bez kompilacji** (spawn `cmd.exe /c echo`, poprawny output i exit code 0).
- Na maszynie nie ma Visual Studio Build Tools i pnpm → **używamy npm workspaces** i wyłącznie modułów natywnych z prebuildami.
- Zainstalowany Claude Code 2.1.283 (`~/.local/bin/claude.exe`). Brak `codex` i `gemini` w PATH (collectory testujemy na fixture'ach).

### 5.3 Fakty o agentach AI (szczegóły w [08-usage-monitor.md](08-usage-monitor.md) i [04-terminals.md](04-terminals.md))

- **Claude Code transcripts:** `~/.claude/projects/<zakodowana-ścieżka>/<sessionId>.jsonl` (ścieżka kodowana przez zamianę `\`, `/`, `:` itp. na `-`, np. `C--Users-jakub-Desktop-Oxytocin`). Linia `type:"assistant"` ma `message.id`, `message.model`, `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`, `service_tier`, `speed`), a na poziomie linii `requestId`, `sessionId`, `cwd`, `timestamp`, `version`, `gitBranch`, `isSidechain`. **Jedna odpowiedź = 2–10 linii z tym samym `message.id`** (po jednej na blok treści) — konieczna deduplikacja. W starszych wersjach `output_tokens` bywały placeholderem (issues #22686, #25941) — w 2.1.283 wartości są realne, ale parser bierze maksimum per `message.id`.
- **Rejestr sesji Claude Code:** `~/.claude/sessions/<pid>.json` z polami `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, `entrypoint`, `name`, `status` (zaobserwowane: `busy`; wg źródeł także `idle`, `shell`, `waiting` + `waitingFor`), `updatedAt`, `statusUpdatedAt`. Oficjalny odpowiednik do skryptów: `claude agents --json` (pola `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`).
- **Claude Code OpenTelemetry:** `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRIC_EXPORT_INTERVAL` (domyślnie 60000 ms), `OTEL_LOGS_EXPORT_INTERVAL` (5000 ms), `OTEL_RESOURCE_ATTRIBUTES`. Metryki `claude_code.token.usage` (atrybut `type`: input/output/cacheRead/cacheCreation, `model`) i `claude_code.cost.usage` (USD), temporalność domyślnie **delta**. Eventy (`claude_code.api_request`, `assistant_response`) **nie niosą już kosztu**. Zmiennych OTEL nie da się ustawić z `.claude/settings.json` repozytorium; procesy hooków dostają env **bez** `OTEL_*`.
- **Claude Code hooks:** istnieje typ `"http"` (POST JSON na URL z nagłówkami), event `Notification` (`notification_type`: `permission_prompt`, `idle_prompt`, `agent_needs_input`, …), `Stop`, `SessionStart`/`SessionEnd`; flaga CLI `--settings '<json>'`.
- **Claude Code a terminal:** Shift+Enter działa natywnie w terminalach z kitty keyboard protocol; w innych działa **Option/Meta+Enter (`ESC` + `CR`)** i Ctrl+J. Claude Code wymusza w VS Code `terminal.integrated.gpuAcceleration: "off"` (artefakty renderera WebGL xterm.js) → **domyślny renderer Oxytocin = DOM**.
- **Codex CLI:** `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl` (+ `archived_sessions/`); `session_meta` (cwd, id), `turn_context` (model), `event_msg` z `payload.type == "token_count"` (`info.total_token_usage`, `info.last_token_usage`: `input_tokens` (zawiera cached), `cached_input_tokens`, `output_tokens` (zawiera reasoning), `reasoning_output_tokens`, `total_tokens`).
- **Gemini CLI:** od 0.60 czaty w `~/.gemini/tmp/<projectHash>/chats/*.jsonl` (`session_metadata`, wiadomości `user`/`gemini` z `tokens: {input, output, cached, thoughts, tool, total}`, rekordy `message_update`); wcześniej pliki `.json`. Telemetria przez env: `GEMINI_TELEMETRY_ENABLED`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_OTLP_ENDPOINT`, `GEMINI_TELEMETRY_OTLP_PROTOCOL=grpc|http`; event `gemini_cli.api_response` z `input_token_count`, `output_token_count`, `cached_content_token_count`, `thoughts_token_count`, `tool_token_count`.
- **Cennik:** `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (≈2,9 MB, ~4400 modeli). Pola: `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`, `cache_creation_input_token_cost_above_1hr`, warianty `*_above_200k_tokens`, `*_priority`, `provider_specific_entry.fast` (mnożnik trybu fast), `litellm_provider`, `mode`. Zawiera m.in. `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5`, `gpt-5.3-codex`, `gpt-6-*`, `gemini-3.x`.

### 5.4 Źródła

- Electron release schedule — https://releases.electronjs.org/schedule
- Electron releases — https://github.com/electron/electron/releases
- xterm.js 6.0.0 release notes — https://newreleases.io/project/github/xtermjs/xterm.js/release/6.0.0 , https://github.com/xtermjs/xterm.js/releases
- xterm.js kitty keyboard protocol PR #5600 — https://github.com/xtermjs/xterm.js/pull/5600
- node-pty — https://github.com/microsoft/node-pty
- Dockview rendering / iframes — https://dockview.dev/docs/core/panels/rendering/ , https://dockview.dev/docs/advanced/iframe/
- electron-vite (worker/utility process, aliasy) — https://github.com/alex8088/electron-vite/issues/851 , https://github.com/alex8088/electron-vite-worker-example
- Claude Code monitoring (OTel) — https://code.claude.com/docs/en/monitoring-usage
- Claude Code hooks — https://code.claude.com/docs/en/hooks
- Claude Code terminal config — https://code.claude.com/docs/en/terminal-config
- Claude Code JSONL — https://claude-dev.tools/docs/jsonl-format , https://github.com/anthropics/claude-code/issues/25941
- Rejestr sesji / `claude agents --json` — https://gist.github.com/yurukusa/5b37902731853fcbb40238dd18dde801 , https://github.com/BrutalSystems/birddog/issues/3
- ccusage (Codex, tryby kosztów) — https://ccusage.com/guide/codex/ , https://ccusage.com/guide/cost-modes
- Gemini CLI telemetry — https://geminicli.com/docs/cli/telemetry/ , https://github.com/google-gemini/gemini-cli/pull/9113
- Gemini CLI chat JSONL — https://github.com/google-gemini/gemini-cli/pull/23749 , https://github.com/jorguez96/aiusage/pull/7
- Codex rollouts — https://github.com/openai/codex/issues/47003 , https://github.com/rjwalters/loom/pull/8641
- LiteLLM pricing — https://github.com/BerriAI/litellm
- node:sqlite w Electron — https://github.com/yinxulai/one-switch/issues/9
