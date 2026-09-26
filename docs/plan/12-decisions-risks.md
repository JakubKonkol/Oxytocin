# 12 — Decyzje architektoniczne (ADR), ryzyka i otwarte pytania

Format ADR: **Kontekst → Decyzja → Alternatywy → Konsekwencje**. Status: `Przyjęta` / `Do weryfikacji (spike)` / `Zastąpiona przez ADR-0xx`. Nowe decyzje dopisuj na końcu listy z kolejnym numerem.

## ADR-001 — Electron + TypeScript + React
- **Status:** Przyjęta (wymóg właściciela).
- **Kontekst:** Hub z terminalami, widokami webowymi i wtyczkami HTML/JS/CSS; priorytet Windows.
- **Decyzja:** Electron 44 (najnowszy stable), TypeScript, React 19.
- **Alternatywy:** Tauri (mniejszy rozmiar, ale WebView2/WebKit różnią się między platformami, brak Node dla node-pty i wtyczek — wymagałby Rust sidecarów), Wails, natywne UI.
- **Konsekwencje:** Duży instalator (~100 MB), ale spójny Chromium na wszystkich OS, bogaty ekosystem (xterm.js, Monaco, dockview), wtyczki webowe „za darmo”.

## ADR-002 — electron-vite 5 + Vite 7 + electron-builder
- **Status:** Przyjęta.
- **Kontekst:** Potrzebny szybki dev (HMR), wiele wejść main (utility processes), pakowanie z modułami natywnymi.
- **Decyzja:** electron-vite 5.0 (peer Vite ≤ 7 → Vite 7.3), electron-builder 26.
- **Alternatywy:** Electron Forge + plugin Vite (oficjalny, ale mniej elastyczny przy wielu wejściach i utility processes), własny Vite + tsup, Vite 8 z electron-vite 6 beta (niestabilne).
- **Konsekwencje:** Blokada na Vite 7 do czasu stabilnego electron-vite 6; wejścia utility processes jako `rollupOptions.input` (unikamy `?modulePath` z problemem aliasów).

## ADR-003 — npm workspaces, TypeScript 6.0
- **Status:** Przyjęta.
- **Kontekst:** Na maszynie brak pnpm i narzędzi kompilacji C++; typescript-eslint 8.70 wspiera TS < 6.1.
- **Decyzja:** npm workspaces; katalog główny = aplikacja; `packages/*` i `plugins/*` jako workspace'y. TypeScript `~6.0.3`.
- **Alternatywy:** pnpm (szybszy, ale symlinki komplikują electron-builder i moduły natywne), TS 7 natywny (brak wsparcia typescript-eslint).
- **Konsekwencje:** Upgrade do TS 7 po wsparciu w typescript-eslint (osobne zadanie).

## ADR-004 — Model procesów: trzy utility processes
- **Status:** Przyjęta.
- **Kontekst:** Main musi być responsywny; node-pty to kod natywny; burze zdarzeń FS i parsowanie git; wtyczki mogą się zawiesić.
- **Decyzja:** PTY Host, Workspace Host, Plugin Host jako `utilityProcess` ([01 §2](01-architecture.md)).
- **Alternatywy:** wszystko w main (ryzyko zamrożeń UI), `worker_threads` w main (node-pty nie jest thread-safe; crash wątku natywnego zabija main), osobne procesy Node (`child_process.fork` — brak integracji z Electron, MessagePortMain).
- **Konsekwencje:** Więcej kodu RPC; +~3×30 MB RAM; lepsza odporność i restartowalność.

## ADR-005 — PTY Host z lustrem `@xterm/headless` i bezpośrednim MessagePort
- **Status:** Przyjęta (S1, S3 potwierdzają).
- **Kontekst:** Wymóg „ten sam bufor po powrocie do projektu” i procesy niezależne od UI.
- **Decyzja:** Każdy terminal ma lustro headless w PTY Host (źródło prawdy bufora), snapshot przez SerializeAddon; I/O renderer ⇄ PTY Host przez MessagePort z numerami sekwencji, batchingiem i flow control ACK.
- **Alternatywy:** bufor tylko w rendererze (utrata przy reloadzie/eviction), zapisywanie surowego strumienia bajtów (nieograniczony rozmiar, wolny replay), tmux/ConPTY daemon (brak na Windows, złożoność).
- **Konsekwencje:** Dwukrotne parsowanie VT (host + renderer) i podwójna pamięć bufora — akceptowalne (wzorzec VS Code); umożliwia rehydratację i persystencję scrollbacku.

## ADR-006 — dockview-react jako silnik układu
- **Status:** Przyjęta (S3 do potwierdzenia szczegółów).
- **Kontekst:** Taby + podziały + DnD + serializacja + panele z iframe'ami.
- **Decyzja:** `dockview-react` 8.3 (Dockview dla centrum, Paneview dla sidebara), `renderer: 'always'`.
- **Alternatywy:** golden-layout 2 (słabsza integracja z React, mniej aktywny), react-mosaic (brak tabów, brak iframe-safe rendering), flexlayout-react (dobry, ale brak odpowiednika Paneview i trybu `always` o tej samej prostocie), własny silnik (koszt).
- **Konsekwencje:** Zależność od jednej biblioteki o średniej popularności — izolujemy ją w `features/layout` (panel registry, persistence), by ewentualna wymiana nie dotykała domen.

## ADR-007 — Wtyczki: widoki w iframe (`oxy-plugin://`) + backend w Plugin Host
- **Status:** Przyjęta.
- **Kontekst:** Wtyczki w HTML/JS/CSS, sloty w UI, izolacja od powłoki.
- **Decyzja:** Widoki jako sandboxowane iframe'y z własnym originem i CSP; backend Node w wspólnym Plugin Host; deklaratywny manifest w `package.json` (`"oxytocin"`); status bar deklaratywny.
- **Alternatywy:** `WebContentsView` per widok (silniejsza izolacja, ale bolesne pozycjonowanie nad DOM, z-order, DnD, koszt pamięci), Web Components w DOM powłoki (brak izolacji CSS/JS), wtyczki tylko UI bez backendu (za słabe dla Usage Monitora).
- **Konsekwencje:** Backend nie jest sandboxem (jak w VS Code) — uczciwie komunikowane w dialogu zgody; widoki są bezpieczne.

## ADR-008 — Systemowy git CLI
- **Status:** Przyjęta.
- **Kontekst:** Poprawność 1:1 z tym, co widzi użytkownik i agent (konfiguracja, atrybuty, LFS, filtry), wydajność na dużych repo.
- **Decyzja:** `git` z PATH (lub `git.path`), `--no-optional-locks`, porcelain v2 `-z`, `cat-file --filters`.
- **Alternatywy:** isomorphic-git (wolny `status`, brak części funkcji), simple-git (tylko wrapper — i tak parsujemy sami), dugite (bundluje git ~50 MB; możliwe w przyszłości dla użytkowników bez gita).
- **Konsekwencje:** Wymagany zainstalowany git ≥ 2.30 (typowe dla odbiorców).

## ADR-009 — Renderer xterm: DOM domyślnie, WebGL opcjonalnie
- **Status:** Przyjęta.
- **Kontekst:** Claude Code wymusza w VS Code `terminal.integrated.gpuAcceleration: "off"` z powodu artefaktów renderera WebGL xterm.js; Chromium ma limit ~16 kontekstów WebGL na stronę; xterm 6 usunął renderer canvas.
- **Decyzja:** `terminal.renderer = 'dom'` domyślnie; WebGL jako opcja z fallbackiem na utratę kontekstu i limitem 8 aktywnych kontekstów.
- **Alternatywy:** WebGL domyślnie (szybszy przy ogromnym outpucie, ale ryzyko artefaktów z najważniejszym agentem).
- **Konsekwencje:** Nieco wyższe zużycie CPU przy bardzo dużym outpucie; do ponownej oceny po testach wydajności (M1) i nowych wersjach xterm.

## ADR-010 — Monaco DiffEditor (read-only) do diffów
- **Status:** Przyjęta (S8).
- **Kontekst:** Diff side-by-side/inline, kolorowanie składni, zwijanie niezmienionych fragmentów, nawigacja po zmianach.
- **Decyzja:** `monaco-editor` 0.57 lokalnie (editor.api + basic-languages + editor.worker), bez workerów językowych.
- **Alternatywy:** CodeMirror 6 `@codemirror/merge` (lżejszy, mniej funkcji diffu), diff2html / @git-diff-view (tylko unified/split HTML — dobre dla trybu Review, M8).
- **Konsekwencje:** +~3–5 MB bundla (akceptowalne w Electron); tryb Review może użyć lżejszego renderera.

## ADR-011 — Usage: lokalne logi domyślnie, OTLP opt-in, bez proxy
- **Status:** Przyjęta (S6, S7).
- **Kontekst:** Wymóg „z logów lub z wstrzykniętych zmiennych środowiskowych”; zmienne `OTEL_*` są ogólne i mogą przejąć telemetrię innych programów; proxy HTTP ingeruje w uwierzytelnianie.
- **Decyzja:** JSONL/rollouty/czaty jako źródło podstawowe (działa też dla sesji spoza Oxytocin i dla historii), OTLP jako opcja (dokładna atrybucja terminala, koszt raportowany), zasada jednego źródła na sesję.
- **Alternatywy:** tylko OTLP (brak historii, konflikty env), proxy (odrzucone), parsowanie outputu terminala (kruche — tylko backlog dla agentów bez logów).
- **Konsekwencje:** Zależność od nieudokumentowanych formatów plików → tolerancyjne parsery, fixture'y, testy, zakładka „Sources” z diagnostyką.

## ADR-012 — `node:sqlite` dla danych Usage Monitora
- **Status:** Przyjęta (wstępnie potwierdzone; S2).
- **Kontekst:** Setki tysięcy zdarzeń, agregacje SQL, brak toolchainu C++.
- **Decyzja:** Wbudowany `node:sqlite` (`DatabaseSync`) w worker thread wtyczki.
- **Alternatywy:** better-sqlite3 13 (dojrzały, prebuildy — fallback), pliki JSON (nieskalowalne), IndexedDB w widoku (niedostępne dla backendu).
- **Konsekwencje:** API synchroniczne → worker thread obowiązkowy; stabilność modułu w Node 24 (release candidate) — monitorować przy upgrade'ach Electrona.

## ADR-013 — `@parcel/watcher` dla watcherów projektów
- **Status:** Przyjęta (S4).
- **Kontekst:** Duże repozytoria, burze zdarzeń, Windows.
- **Decyzja:** `@parcel/watcher` 2.6 w Workspace Host + ignorowane foldery + odświeżanie okresowe jako siatka bezpieczeństwa.
- **Alternatywy:** chokidar 5 (JS, `fs.watch`; wolniejszy start na dużych drzewach), `fs.watch` recursive (brak ignorowania na poziomie natywnym).
- **Konsekwencje:** Moduł natywny z prebuildami (asarUnpack).

## ADR-014 — Zustand + Tailwind v4 + Radix
- **Status:** Przyjęta.
- **Decyzja:** Stan UI w Zustand (dostęp poza React dla xterm/IPC), style Tailwind v4 oparte o CSS variables (współdzielone z dockview/xterm/Monaco/wtyczkami), prymitywy Radix.
- **Alternatywy:** Redux Toolkit (więcej ceremonii), Jotai (atomy — mniej naturalne dla stanu domenowego), CSS Modules (brak wspólnych utility).
- **Konsekwencje:** Zakaz literałów kolorów poza `tokens.css`.

## ADR-015 — Stan agentów: rejestr sesji Claude Code + sygnały terminala
- **Status:** Do weryfikacji (S5).
- **Kontekst:** Wskaźnik „agent pracuje / czeka na Ciebie” to kluczowa wartość produktu; Claude Code zapisuje `~/.claude/sessions/<pid>.json` ze `status`, istnieje `claude agents --json`.
- **Decyzja:** Źródła według priorytetu: hook (M9) > rejestr Claude > OSC 9;4 > BEL/notyfikacje > heurystyka outputu; parsowanie tolerancyjne, fallback na `claude agents --json`.
- **Alternatywy:** tylko heurystyka outputu (niedokładna), wymuszenie hooków w konfiguracji użytkownika (narusza zasadę nieinwazyjności).
- **Konsekwencje:** Zmiany formatu rejestru w nowych wersjach Claude Code mogą degradować stan do heurystyk — logowanie nieznanych wartości i szybka aktualizacja mapowania.

## ADR-016 — Routing wiadomości widoków przez powłokę i main (v1)
- **Status:** Przyjęta.
- **Kontekst:** Widoki wtyczek potrzebują komunikacji z backendem; bezpośrednie porty iframe ⇄ Plugin Host wymagają transferu portów przez preload i obsługi restartów.
- **Decyzja:** iframe ⇄ MessagePort ⇄ ViewBridge (renderer) ⇄ IPC ⇄ main ⇄ Plugin Host, z limitami rozmiaru i częstotliwości.
- **Alternatywy:** bezpośredni MessagePort (mniej skoków — optymalizacja na później).
- **Konsekwencje:** Dodatkowe opóźnienie (~1 ms) nieistotne dla typowych widoków.

## ADR-017 — Keep-alive LRU workspace'ów + rehydratacja
- **Status:** Przyjęta.
- **Kontekst:** Przełączanie „natychmiastowe” vs pamięć przy wielu projektach.
- **Decyzja:** Do `workspace.keepAliveProjects` (4) zamontowanych workspace'ów ukrywanych `display:none`; starsze odmontowywane i odtwarzane ze snapshotu PTY Host.
- **Konsekwencje:** Dwie ścieżki odtwarzania (zamontowany / rehydratacja) — obie testowane E2E.

## ADR-018 — Język angielski w całym projekcie
- **Status:** Przyjęta (decyzja właściciela, 2026-09-26).
- **Kontekst:** Właściciel zdecydował, że produkt i repozytorium są anglojęzyczne.
- **Decyzja:** Po angielsku jest **wszystko, co powstaje w repozytorium i w aplikacji**: interfejs użytkownika (etykiety, menu, dialogi, powiadomienia, komunikaty błędów), UI wtyczek wbudowanych, `README.md`, `CHANGELOG.md`, komentarze w kodzie, nazwy identyfikatorów, komunikaty logów, komunikaty commitów, opisy PR, dokumentacja dla twórców wtyczek, wyniki spike'ów (`docs/spikes/`), wpisy w „Dzienniku implementacji”, teksty testów (`describe/it`). Brak frameworka i18n i brak ustawienia języka. Wyjątek: dokumenty tego planu (`docs/plan/`) pozostają po polsku.
- **Alternatywy:** i18n `pl` + `en` (poprzednia wersja tego ADR) — odrzucone jako zbędny narzut.
- **Konsekwencje:** Prostszy kod (bez `t()` i plików tłumaczeń); polskie etykiety z prototypu i przykładów w planie należy tłumaczyć wg [02 §13](02-ui-ux.md). Ewentualna lokalizacja w przyszłości wymaga nowego ADR.

## ADR-019 — Cennik z LiteLLM (snapshot + odświeżanie)
- **Status:** Przyjęta.
- **Kontekst:** Ceny modeli zmieniają się często; potrzebne stawki cache 5m/1h, tiery > 200k, priority, fast.
- **Decyzja:** Snapshot generowany skryptem z `model_prices_and_context_window.json` + codzienne odświeżanie (wyłączalne) + nadpisania użytkownika.
- **Alternatywy:** ręcznie utrzymywana tabela (szybko się starzeje), pobieranie przy każdym starcie bez snapshotu (brak działania offline).
- **Konsekwencje:** Zależność od poprawności danych LiteLLM — zakładka „Pricing” pokazuje źródło i pozwala nadpisać.

## ADR-020 — Licencja MIT
- **Status:** Przyjęta (decyzja właściciela, 2026-09-26).
- **Decyzja:** Projekt na licencji **MIT**: plik `LICENSE` w katalogu głównym (standardowy tekst MIT, `Copyright (c) 2026 <imię i nazwisko właściciela z git config user.name>`), `"license": "MIT"` w `package.json` aplikacji i we wszystkich pakietach/wtyczkach wbudowanych (`packages/*`, `plugins/*`).
- **Zgodność zależności:** dozwolone licencje zależności runtime: MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, OFL-1.1 (fonty), MPL-2.0 (tylko bez modyfikacji plików). Zabronione bez nowego ADR: GPL/LGPL/AGPL, SSPL, licencje niekomercyjne. Kontrola w CI: `npx license-checker-rseidelsohn --production --onlyAllow "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;0BSD;OFL-1.1;MPL-2.0;CC0-1.0;BlueOak-1.0.0;Python-2.0"` (lista do dopracowania przy pierwszym uruchomieniu).
- **Atrybucje:** `THIRD_PARTY_NOTICES.md` generowany skryptem (`scripts/generate-notices.ts`) z licencjami zależności produkcyjnych + ręczne wpisy dla zasobów niepochodzących z npm: skrypty shell integration adaptowane z VS Code (MIT, zachowany nagłówek), fonty Inter i JetBrains Mono (OFL-1.1, pliki licencji obok fontów), dane cennika LiteLLM (MIT — atrybucja w pliku snapshotu). Plik dołączany do paczki aplikacji (`extraResources`) i dostępny z menu „Help → Third-Party Notices”; okno „About” pokazuje licencję MIT.
- **Konsekwencje:** Wtyczki zewnętrzne mogą mieć dowolną licencję (są dystrybuowane osobno).

---

## Rejestr ryzyk

| # | Ryzyko | Prawdop. | Wpływ | Mitygacja |
|---|---|---|---|---|
| R1 | node-pty/ConPTY: błędy renderowania, reflow przy resize, problemy po spakowaniu | Średnie | Wysoki | S1 (spakowany build), `useConptyDll` + przełącznik na systemowy ConPTY, `windowsPty` w xterm, testy E2E na Windows w CI. |
| R2 | Zmiana formatu JSONL/rejestru sesji Claude Code (nieudokumentowane) | Wysokie (w horyzoncie roku) | Średni | Tolerancyjne parsery z zod `.passthrough()`, fixture'y z wersjami, zakładka „Sources”, OTLP jako alternatywa, `claude agents --json` jako fallback stanu. |
| R3 | Niedokładne koszty (cennik, subskrypcje, tiery) | Średnie | Średni | Oznaczanie estymacji `≈`, koszt raportowany vs wyliczony w szczegółach sesji, nadpisania stawek, S6. |
| R4 | Wydajność: wiele terminali + podwójne parsowanie VT + dużo outputu | Średnie | Wysoki | Batching, flow control, DOM renderer z opcją WebGL, LRU, budżety wydajności w CI, profilowanie w M1. |
| R5 | dockview: ograniczenia (reorder Paneview z iframe, stylizacja, zmiany API w 8.x) | Średnie | Średni | S3, izolacja w `features/layout`, pinowanie wersji. |
| R6 | Konflikt zmiennych `OTEL_*` z telemetrią aplikacji użytkownika | Średnie | Średni | OTLP opt-in, zakres `profileIds`, wykrywanie istniejącej konfiguracji. |
| R7 | Monaco pod `app://` i CSP (workery, fonty) | Niskie | Średni | S8; fallback: `worker-src blob:` + ładowanie workera jako blob. |
| R8 | Skróty klawiszowe kolidujące z agentami/powłokami (np. Ctrl+B w Claude Code) | Średnie | Średni | Zasada Ctrl+Shift/Alt+Shift w terminalu, konfigurowalne skróty (M7). |
| R9 | Linux: node-pty 1.1.0 bez prebuildów | Pewne | Niski (platforma drugorzędna) | Kompilacja w CI (build-essential), ewentualnie node-pty 1.2 z prebuildami linux po wydaniu stabilnym. |
| R10 | `node:sqlite` (RC w Node 24) — regresje przy upgrade Electrona | Niskie | Średni | Warstwa `db.ts` izoluje API; fallback better-sqlite3. |
| R11 | Wtyczki zewnętrzne z pełnym dostępem Node | Średnie (M9) | Wysoki | Dialog zgody, tryb dev wymagany do ładowania z folderu, osobny host dla zewnętrznych (M9). |
| R12 | Zabicie procesów użytkownika przez pomyłkę (zamknięcie, usunięcie projektu, aktualizacja) | Niskie | Wysoki | `QuitGuard`, potwierdzenia, aktualizacja tylko przy restarcie inicjowanym przez użytkownika. |

## Otwarte pytania (z przyjętymi założeniami — nie blokują implementacji)

| # | Pytanie | Założenie przyjęte w planie |
|---|---|---|
| Q1 | Licencja projektu | **Rozstrzygnięte:** MIT (ADR-020). |
| Q2 | Język UI i repozytorium | **Rozstrzygnięte:** wyłącznie angielski — UI, README, komentarze, commity (ADR-018). |
| Q3 | Czy aplikacja ma działać „w tle” po zamknięciu okna (tray), aby agenci pracowali dalej? | Nie w MVP; zamknięcie okna = wyjście z `QuitGuard`. Opcja „zamknij do zasobnika” w backlogu. |
| Q4 | Zdalne repozytorium (GitHub) i CI | Pliki workflow przygotowane; uruchomienie po utworzeniu zdalnego repo przez właściciela. |
| Q5 | Domyślny tryb rozliczeń (API vs subskrypcja) dla Claude Code | `api` (koszt bez `≈`); użytkownik przełącza w ustawieniach Usage. |
| Q6 | Czy wspierać macOS/Linux ręcznymi testami od MVP? | Nie ręcznie — tylko CI; ręczne testy na Windows 11. |
| Q7 | Nazwa/identyfikator aplikacji (`appId`) i ikona | `dev.oxytocin.app`, ikona tymczasowa do czasu projektu graficznego. |
