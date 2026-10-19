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

- [ ] Changes, Impact i selektor checkoutu działają; eksport zrobiony albo świadomie pominięty (decyzja zapisana).
- [ ] Ewaluacja opublikowana z przypadkami negatywnymi; bramka korzyści oceniona uczciwie.
- [ ] Teksty README/CHANGELOG o korzyściach tylko w zakresie wspartym wynikami.
- [ ] `npm run check` + E2E zielone.

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
