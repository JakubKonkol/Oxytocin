# 00 — Wizja, zasady i zakres

## 1. Wizja

**Oxytocin** to scentralizowane, dedykowane środowisko pracy (hub) dla programistów, którzy pracują z agentami AI działającymi w terminalu (Claude Code, Codex CLI, Gemini CLI, Aider, OpenCode…). Pełni rolę **„IDE dla terminala i AI”**: daje wizualną nakładkę, która organizuje kontekst (projekty), procesy (terminale i agenci), zmiany w kodzie (diff względem ostatniego commita) i koszty API — **bez ingerencji w to, w jakim edytorze użytkownik faktycznie pisze kod**.

### Problem, który rozwiązujemy

| Ból dziś | Jak odpowiada Oxytocin |
|---|---|
| 5–15 okien terminala rozrzuconych po wielu projektach; nie wiadomo, gdzie agent właśnie pracuje, a gdzie czeka na decyzję. | Lista projektów z **wskaźnikami aktywności** (pracuje / czeka na Ciebie / proces działa / błąd) i powiadomieniami. |
| Przełączenie projektu = szukanie właściwych okien, zamykanie/otwieranie terminali, utrata scrollbacku. | **Przełączanie w locie**: każdy projekt ma własny, zamrażany i przywracany układ terminali; procesy nigdy nie są zabijane. |
| Agent zmienia kilkadziesiąt plików; weryfikacja wymaga osobnego narzędzia git. | **Panel Zmian na żywo**: drzewo plików zmienionych względem HEAD, liczniki +/−, diff jednym kliknięciem. |
| Nie wiadomo, ile kosztuje sesja agenta, dopóki nie przyjdzie faktura / limit. | **Usage Monitor**: tokeny i koszt USD w czasie rzeczywistym per sesja/projekt/model, budżety i limity. |
| Każde narzędzie ma swoje „panele”; brak jednego miejsca na integracje. | **Silnik wtyczek webowych** ze slotami UI — hub rozszerzalny od pierwszego dnia. |

### Persona główna

**„AI-first developer”** — senior/mid, pracuje równolegle w 2–6 repozytoriach, uruchamia agentów CLI w kilku terminalach naraz, ma ulubiony edytor (VS Code, Cursor, JetBrains, Neovim, Zed) i nie chce go zmieniać. Pracuje głównie na Windows 11 (platforma priorytetowa), ale często także na macOS/Linux. Ceni skróty klawiszowe, szybkość i przejrzystość kosztów.

## 2. Zasady produktowe (obowiązują przy każdej decyzji)

1. **Terminal-first, nie edytor.** Oxytocin nigdy nie edytuje plików użytkownika z własnej inicjatywy. Jedyne modyfikacje to jawne akcje użytkownika (Discard, Commit) z potwierdzeniem. Podgląd diffu jest tylko do odczytu; „Open in editor” deleguje do edytora użytkownika.
2. **Procesy są święte.** Żadna akcja UI (przełączenie projektu, zamknięcie widoku, zmiana układu, reload renderera) nie zabija procesu. Proces kończy się wyłącznie przez jawne zamknięcie terminala, usunięcie projektu lub wyjście z aplikacji — zawsze z potwierdzeniem, jeśli coś działa.
3. **Nieinwazyjność.** Nie modyfikujemy konfiguracji narzędzi użytkownika (`~/.claude/settings.json`, `.bashrc`, `config.toml` Codexa…) bez wyraźnej zgody. Integracje głębsze niż czytanie logów są opt-in. Nie zapisujemy niczego w repozytoriach użytkownika.
4. **Natychmiastowość.** Przełączenie projektu < 100 ms (zamontowany), pojawienie się zmiany pliku w panelu < 1 s, echo klawisza w terminalu bez odczuwalnego opóźnienia.
5. **Rozszerzalność od dnia 1 (dogfooding).** Funkcje, które da się zbudować na publicznym API wtyczek, budujemy jako wtyczki wbudowane (Usage Monitor, Markdown Preview). Jeśli wtyczka wbudowana potrzebuje „tylnych drzwi”, to znak, że brakuje publicznego API.
6. **Local-first, prywatność.** Zero telemetrii aplikacji. Wszystkie dane (koszty, stan) lokalnie w `userData`. Z logów agentów czytamy tylko metadane zużycia, nigdy nie przechowujemy treści rozmów.
7. **Windows-first, cross-platform.** Każda funkcja działa na Windows 11; kod ma gałęzie dla macOS i Linux, a CI uruchamia testy na trzech systemach.
8. **Angielski i open source (MIT).** Produkt i repozytorium są w całości anglojęzyczne (UI, README, komentarze, commity — ADR-018); kod na licencji MIT (ADR-020).
9. **Uczciwość danych.** Gdy liczba jest estymacją (koszt wyliczony z cennika, heurystyczny stan agenta), UI to sygnalizuje (np. „≈”, tooltip ze źródłem danych).

## 3. Zakres

### 3.1 MVP — wersja 0.1 (kamienie M0–M6)

- Projekty: dodawanie folderów (dialog, drag&drop, CLI), lista z wskaźnikami aktywności, przełączanie w locie z zachowaniem terminali, przywracanie układu po restarcie.
- Terminale: pełny emulator (xterm.js 6) z ConPTY/PTY, profile powłok (pwsh, PowerShell, cmd, Git Bash, WSL, bash/zsh/fish), taby, podziały pionowe/poziome, drag&drop paneli, wyszukiwanie, linki (URL i ścieżki plików), kopiuj/wklej zgodnie z konwencjami Windows Terminal, poprawny Shift+Enter dla agentów.
- Wykrywanie agentów (Claude Code, Codex, Gemini CLI, Aider, OpenCode, …) i ich stanu; znaczki „AI AGENT” / „SHELL” / „PROCESS” na panelach; powiadomienia „Agent is waiting for you”.
- Panel Zmian: drzewo plików zmienionych względem HEAD (A/M/D/R/U), liczniki linii, odświeżanie na żywo, diff side-by-side/inline w obszarze centralnym, „Open in editor”.
- Silnik wtyczek: manifest, Plugin Host, widoki iframe, sloty (sidebar, panel centralny, pasek statusu, polecenia, ustawienia, zmienne środowiskowe terminali, „file openers”), SDK + typy.
- Wtyczki wbudowane: **Usage Monitor** (Claude Code, Codex, Gemini CLI; koszt dzienny/sesji/projektu, burn rate, budżety/limity, dashboard) i **Markdown Preview**.
- Pakowanie instalatora Windows (NSIS, niepodpisany) + buildy macOS/Linux z CI.

### 3.2 Wersja 0.2 (M7–M8)

- Paleta poleceń i Quick Open, edytowalne skróty (`keybindings.json`), UI ustawień, motyw jasny.
- Shell integration (OSC 633/133) dla pwsh/bash/zsh/fish: śledzenie cwd, granice komend, kody wyjścia, powiadomienia o zakończeniu długich komend.
- „Resume agent session” po restarcie (`claude --resume <id>`, `codex resume <id>`).
- Akcje Git: Discard (plik/wszystko, nieśledzone do Kosza), Stage/Unstage, Commit z wiadomością; tryb „Review” (wszystkie diffy w jednym przewijanym widoku).

### 3.3 Wersja 0.3+ (M9 i backlog)

- Podpisywanie kodu, auto-update, szablon `create-oxytocin-plugin`, instalacja wtyczek zewnętrznych z folderu/zip z ekranem zgody.
- Wtyczka „Claude Code Bridge” (hooki HTTP → dokładne stany agenta i atrybucja), checkpointy git przed uruchomieniem agenta, serwer MCP wystawiający stan Oxytocin agentom, projekty WSL/SSH, wiele okien, tryb „detached PTY daemon” (procesy przeżywają zamknięcie aplikacji).

### 3.4 Non-goals (świadomie NIE robimy)

- Edytora kodu, IntelliSense, LSP, debuggera.
- Pełnego klienta Git (branche, merge, rebase, historia, konflikty) — tylko to, co służy weryfikacji pracy agenta.
- Własnego czatu AI / wywoływania API modeli z aplikacji — agenci działają w terminalach.
- Proxy HTTP przechwytującego ruch do API (ingerencja w uwierzytelnianie, TLS, subskrypcje).
- Synchronizacji w chmurze, kont użytkowników, telemetrii produktu.
- Marketplace'u wtyczek (w MVP).

## 4. Słownik

| Termin | Znaczenie |
|---|---|
| **Projekt** | Lokalny katalog dodany do Oxytocin; jednostka kontekstu (własny układ, terminale, watcher git). |
| **Workspace (projektu)** | Stan obszaru centralnego projektu: układ dockview + panele (terminale, diffy, widoki wtyczek). |
| **Zamontowany workspace** | Workspace, którego drzewo React/xterm istnieje w rendererze (widoczny lub ukryty). Limit LRU. |
| **Rehydratacja** | Odtworzenie widoku terminala z snapshotu bufora PTY Host po tym, jak widok został zniszczony. |
| **Panel** | Element dockview (terminal, diff, widok wtyczki, ekran powitalny). |
| **Grupa** | Kontener paneli dockview z paskiem tabów; podziały tworzą siatkę grup. |
| **Profil terminala** | Definicja uruchomienia: plik wykonywalny, argumenty, env, ikona (np. „PowerShell 7”, „Claude Code”). |
| **PTY Host** | utilityProcess z node-pty i lustrzanym buforem `@xterm/headless` dla każdego terminala. |
| **Workspace Host** | utilityProcess z watcherami systemu plików i wywołaniami git. |
| **Plugin Host** | utilityProcess uruchamiający backendy (część Node) wtyczek. |
| **Agent** | Proces AI CLI wykryty w drzewie procesów terminala (np. `claude.exe`). |
| **Sesja agenta** | Logiczna rozmowa agenta (np. `sessionId` Claude Code) — nośnik zużycia tokenów. |
| **Stan agenta** | `working` / `idle` / `waiting` (czeka na użytkownika) / `unknown`. |
| **Aktywność projektu** | Zagregowany stan terminali projektu wyświetlany jako kropka/ikona na liście. |
| **Slot** | Nazwane miejsce w UI, w którym wtyczka może osadzić widok lub element (np. `sidebar`, `statusbar`). |
| **Widok wtyczki** | Strona HTML wtyczki renderowana w sandboxowanym iframe z `oxy-plugin://<id>/…`. |
| **Collector** | Moduł Usage Monitora, który zbiera zdarzenia zużycia z jednego źródła (np. Claude JSONL). |
| **Snapshot** | Zserializowana (sekwencje VT) zawartość bufora terminala + numer sekwencji. |

## 5. Mapa wymagań → dokumenty (traceability)

| ID | Wymaganie (z briefu) | Gdzie zaprojektowane | Kamień |
|---|---|---|---|
| R-WS-1 | Dodanie dowolnego katalogu jako Projektu | [03 §2–3](03-projects-workspace.md) | M3 |
| R-WS-2 | Wizualny status aktywności (kropka, animacja) | [03 §5](03-projects-workspace.md), [04 §9](04-terminals.md), [02 §6](02-ui-ux.md) | M3 |
| R-WS-3 | Przełączanie w locie: zamrażanie/przywracanie bez przerywania procesów | [03 §6](03-projects-workspace.md), [05 §6](05-layout-center.md) | M3 |
| R-GIT-1 | Śledzenie zmian w czasie rzeczywistym (file watcher) | [06 §3](06-git-changes.md) | M4 |
| R-GIT-2 | Diff względem HEAD | [06 §4–7](06-git-changes.md) | M4 |
| R-GIT-3 | Drzewo plików ze statusami A/M/D | [06 §6](06-git-changes.md) | M4 |
| R-GIT-4 | (opcjonalnie) Discard / Commit | [06 §8](06-git-changes.md) | M8 |
| R-TERM-1 | Pełny emulator TTY, ANSI, skróty (Ctrl+C) | [04 §3–7](04-terminals.md) | M1 |
| R-TERM-2 | Split view pion/poziom | [05 §4](05-layout-center.md) | M2 |
| R-TERM-3 | Persystencja sesji przy zmianie projektu (ten sam bufor) | [04 §4–5](04-terminals.md), [03 §6](03-projects-workspace.md) | M1/M3 |
| R-TERM-4 | Wpinanie w panele widoków z pluginów | [05 §3](05-layout-center.md), [07 §7](07-plugin-engine.md) | M5 |
| R-PLG-1 | Wtyczki w HTML/JS/CSS | [07](07-plugin-engine.md) | M5 |
| R-PLG-2 | Dynamiczne dokowanie w slotach (lewy dolny, status bar, centralny) | [07 §8](07-plugin-engine.md) | M5 |
| R-PLG-3 | Usage Monitor: tokeny → USD w czasie rzeczywistym (Claude, OpenAI, Gemini), z logów lub env | [08](08-usage-monitor.md) | M6 |
| R-UI-1 | Zgodność z prototypem (`ui_prototype.png`) | [02](02-ui-ux.md) | M0–M6 |
