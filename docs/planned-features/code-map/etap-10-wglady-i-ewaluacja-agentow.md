# Etap 10 — wglądy (Changes, Impact) i ewaluacja agentów

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.6 FR-VIS-10…12, 5.8 FR-WT-3, 7 BR-5, 11).

## Cel

Wizualizator pomaga przeglądać zmiany (nakładka Changes, widok Impact, selektor checkoutu, eksport), a korzyść dla
agentów zostaje **zmierzona** i opublikowana. Dopiero po tym etapie README/CHANGELOG mogą opisywać zmierzone korzyści.

## Wymagania wejściowe

- Etapy 07 i 09 zrobione.

## Zakres

W zakresie: FR-VIS-10, 11, 12, FR-WT-3, metryki sukcesu (sekcja 11).

## Zadania

### 10.1 Wglądy w wizualizatorze

- **Changes overlay:** plugin łączy status `oxy.git` (istniejące uprawnienie `git.read`) z zapytaniem hosta
  `dependents(paths, depth)`; zmienione pliki podświetlone, potencjalnie zależne zacienione, lista pogrupowana po
  folderach. Dla Ensemble: wybór checkoutu worktree i porównanie z jego bazą.
- **Impact view:** relacje wchodzące do głębokości 3, tekst „Potential dependents in indexed code” i informacja, że lista
  nie jest wyczerpująca (BR-3). Domyślnie bez krawędzi `heuristic`.
- **Checkout selector:** główny folder i aktywne worktree (z `listCheckouts`).
- **Export** bieżącego widoku jako SVG/PNG (Could — można pominąć, jeśli renderer tego nie daje tanio; zapisz decyzję).
- Wycinek `impact` w `src/code-map-host/query/slice.ts`.

### 10.2 Ewaluacja agentów

- Stały korpus co najmniej 20 zadań na repozytoriach: znajdź podsystem, prześledź wywołującego, zmień API, napraw błąd,
  zbadaj nieznany pakiet, zaktualizuj worktree. Także zadania, w których zwykłe wyszukiwanie wystarcza, i zadania z
  nieobsługiwanym/dynamicznym kodem. Oczekiwane pliki i testy akceptacyjne zdefiniowane **przed** uruchomieniem agentów.
- Ten sam agent/model/wersja/ustawienia z Code Map wyłączonym i włączonym; losowa kolejność, świeże checkouty, niezależne
  sesje, każde zadanie ≥ 3 razy; porażki i timeouty zapisywane, nie odrzucane. Instrukcje repozytorium stałe poza
  mierzonym briefem mapy.
- Mierz: poprawność/ukończenie i regresje (wg ustalonych testów i przeglądu); tokeny wejścia/wyjścia z rozróżnieniem
  cache, koszt wg zapisanych stawek dostawcy, wywołania narzędzi, czas, liczba zapytań do mapy; koszt konfiguracji indeksu,
  pracę aktualizacji, pamięć, narzut instrukcji/schematów narzędzi, puste/nieudane wyszukiwania; recall@8 i
  precision/recall relacji na oznaczonych fixture; pierwsze zadanie osobno od powtarzanych.
- Bramka korzyści: ≥ 15% niższa mediana niecache'owanych tokenów wejściowych lub wywołań narzędzi eksploracji, bez
  zaobserwowanej regresji poprawności i bez istotnej regresji mediany czasu zadania. To kierunkowy dowód, nie gwarancja
  statystyczna. Raportuj rozrzut, wyniki parami i zadania, którym mapa zaszkodziła. „Niezwrócone znaki” to nie
  zaoszczędzone tokeny.
- Dostrajaj budżet `MAP.md` i opisy narzędzi wyłącznie na zadaniach treningowych; wynik w
  `results/<data>-agent-evaluation.md` łącznie z przypadkami negatywnymi. Usage Monitor może dostarczyć część pól —
  zweryfikuj granice pomiaru.

## Testy

- Unit/integracja: `dependents(paths, depth)` — limity, cykle, brak heurystyk domyślnie.
- E2E rozszerzenie `code-map-visualizer.spec.ts`: niezacommitowana zmiana → nakładka Changes podświetla plik i zależnych;
  Impact pokazuje tekst o niewyczerpującej liście; przełączenie checkoutu na worktree.

## Kryteria ukończenia

- [x] Changes, Impact i selektor checkoutu działają; eksport świadomie pominięty (decyzja poniżej).
- [x] Owner-authorized scope: frozen corpus, offline harness and protocol published, including negative cases.
- [ ] Paid evaluation results and benefit gate — explicitly deferred to the owner; currently unverified.
- [x] Teksty README/CHANGELOG o korzyściach tylko w zakresie wspartym wynikami (no savings claims).
- [x] `npm run check` green on Windows and Linux; relevant app E2E 22/22 under Docker/Xvfb.

## Commity i CHANGELOG

- `feat(code-map): review changes and their potential dependents in the visualizer`
- `docs(code-map): publish the agent evaluation`

CHANGELOG (`### Added`):

> **Code Map Visualizer:** a Changes overlay highlights uncommitted (or worktree) changes and the indexed code that may
> depend on them; an Impact view lists a symbol's potential dependents; switch between the main folder and active
> worktrees.

## Pułapki

- Nigdy nie nazywaj wyniku „blast radius” ani „all callers”.
- Ewaluacja kosztuje realne tokeny — uzgodnij z właścicielem budżet i konta przed uruchomieniem.

## Implementation decisions (2026-10-20)

- Public `slice` gains `view: 'impact'`, with either a file/symbol root or up to 500 `paths`. The host owns incoming
  traversal, cycles and visit/output limits. File queries project cross-file symbol relations onto their files,
  without consuming `contains` as a hop; symbol queries preserve symbol evidence. Membership is always excluded.
- `oxy.git.getCheckoutChanges(ref)` requires both `git.read` and `code-map.read`, checked again after asynchronous
  work. Main resolves only registered identities and the task's stored base; Workspace Host performs Git I/O. Main
  checkout status remains the existing Git checkpoint. Task comparison uses `baseCommit`, including committed edits;
  `--relative` keeps tracked and untracked paths consistent for projects in repository subfolders.
- Git metadata has independent 500-file / 512 KiB caps; rename old paths participate in impact roots, with visible
  truncation if the combined root set exceeds 500. Git and index checkpoints are separate, not a transactional diff.
  Deleted/unindexed files stay in the Git list; the graph never invents dependents for absent nodes.
- Checkout changes clear history, selection and positions. Removed worktrees fail explicitly, without falling back
  to the main map. Changes use shapes, text labels and folder grouping as well as colors.
- Export is omitted (Could): the current iframe/public API has no export/save flow. Adding and validating that flow
  is deferred; no filesystem permission or external renderer was added just for export.
- The owner's recorded scope for stages 10/14 is harness/corpus preparation only. There were no paid sessions.
  `scripts/code-map-agent-evaluation.ts` validates 26 tasks (6 training, 20 held-out), preregisters randomized paired
  schedules (at least three repetitions), pins corpus/configuration/revision and analyzes normalized results. Missing
  results/metrics, failed/timeout runs and negative outcomes remain explicit. Default material median time regression
  is preregistered at 10%, configurable only downward. Benefits remain unverified.
- Protocol and measurement boundary: [agent-evaluation report](results/2026-10-20-agent-evaluation.md).
  Implementation and validation: [insights report](results/2026-10-20-insights.md).
