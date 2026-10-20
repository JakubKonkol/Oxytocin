# Etap 09 — plugin Code Map Visualizer

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.6, 8.9) i etap 08.

## Cel

**Code Map** otwiera się jako zakładka lub panel i pokazuje widoki Overview, File, Neighborhood i Search aktualnej mapy, z
nawigacją do źródła. Wydanie samodzielne.

## Wymagania wejściowe

- Etap 08 zrobiony (API `oxy.codeMap` 0.2.0).

## Zakres

W zakresie: FR-VIS-1…9, FR-VIS-13, NFR-12.

Poza zakresem: Changes/Impact/selektor checkoutu/eksport (etap 10), Knowledge/Task context (etap 14).

## Zadania

### 9.1 Spike renderera (najpierw)

- Zmierz **Cytoscape.js** (+ layout obsługujący węzły złożone, np. fcose, jeśli licencja przejdzie) w spakowanym iframe
  pluginu: fixture 50/150/500 węzłów z odpowiednimi limitami krawędzi, cykle, huby, długie etykiety, szybkie
  unieważnienia. Zapisz pierwszy używalny układ, opóźnienie wejścia, FPS, pamięć i opóźnienie terminala, wersje,
  licencje, zachowanie CSP/offline w `results/<data>-renderer.md`. Sigma.js (WebGL) tylko, jeśli pomiary tego wymagają.
- Cele: układ domyślnego widoku < 1 s, interakcja p95 < 100 ms, ≤ 10% regresji p95 terminala przy tym samym obciążeniu.
  Gdy układ jest drogi — zatrzymaj/ogranicz go zamiast blokować aplikację; zachowaj widok listy, jeśli inicjalizacja
  grafiki się nie uda.
- Spike sprawdza też: zawieszenie w ukrytym panelu, dostępność WebGL (jeśli używany), nawigację klawiaturą/listą,
  kontrast, otwieranie źródła, zasoby offline w spakowanym buildzie, kompatybilność silnika.

### 9.2 Plugin

- `plugins/code-map-visualizer/` (nowy): pakiet `@oxytocin/code-map-visualizer`, id `oxytocin.code-map-visualizer`,
  `"license": "MIT"`, engine `^0.2.0`, uprawnienia `projects.read`, `code-map.read`; panel `codeMap.view`
  (`singleton: "project"`, `showInAddMenu: true`), polecenie `codeMap.open` („Code Map: Open”).
- Backend przekazuje ograniczone żądania; widok zbudowany na `@oxytocin/plugin-sdk` z tokenami motywu.
- Imperatywne aktualizacje grafu (bez stanu React na każdy tick układu); React tylko dla kontrolek i szczegółów.
- Widok listy (tabela: węzeł, rodzaj, relacja, kierunek, dowód) dostępny z klawiatury; typy krawędzi różnione stylem linii
  i etykietą, nie tylko kolorem.
- Panel szczegółów: ścieżka, rodzaj, sygnatura, zakres, liczby wejść/wyjść, dowody; **Open in editor**.
- Wyszukiwarka, filtry relacji i proweniencji, głębokość 1–3, wstecz/naprzód, pan/zoom/fit, rozwinięcie o jeden krok.
- Stabilne pozycje przetrwałych ID przy odświeżeniach; brak ciągłej animacji całego grafu przy zapisach plików; układ
  zatrzymany, gdy panel ukryty/zamknięty; anulowanie przestarzałych żądań; debounce unieważnień; numer żądania +
  tożsamość checkoutu odrzucają spóźnione odpowiedzi; szybka zmiana projektu natychmiast czyści poprzedni graf.
- Nagłówek zawsze pokazuje projekt, checkout, stan i generację; stopka — obcięcie i pokrycie (układ ekranu z sekcji 8.9).
- Gdy mapa projektu jest wyłączona — link do ustawień Code Map (udokumentowane polecenie rdzenia, przez allowlistę poleceń,
  nie prywatne IPC renderera).
- Wszystkie skrypty, fonty i zasoby układu dołączone lokalnie; test CSP iframe; żadnego CDN ani serwera podglądu.
- Rdzeń: „Open Code Map” w zakładce Code Map i w menu kontekstowym projektu wywołuje polecenie pluginu, gdy plugin jest
  włączony.
- Build/pakowanie: odkrywanie wbudowanych pluginów, `scripts/build-plugins.ts`, noty licencyjne (`npm run licenses:notices`).

## Testy

- E2E `tests/e2e/code-map-visualizer.spec.ts`: otwarcie → Overview pokazuje foldery fixture → wyszukanie symbolu →
  Neighborhood → otwarcie w edytorze we właściwej linii → zapis edycji → widok się odświeża, zachowując pozycje → zmiana
  projektu → ukrycie/pokazanie panelu → wyłączenie pluginu → MCP nadal odpowiada. Nawigacja wyłącznie klawiaturą po
  liście.
- Unit widoku: odrzucanie spóźnionych odpowiedzi, zachowanie pozycji, czyszczenie przy zmianie projektu.

## Kryteria ukończenia

- [x] Overview, File, Neighborhood i Search kompletne; widoki z etapów 10/14 nie pojawiają się jako martwe kontrolki.
- [x] Wszystkie widoki respektują limity węzłów/krawędzi/bajtów i pokazują checkout, generację, pokrycie i pominięcia.
- [x] Wyłączenie/zamknięcie i szybkie zmiany kontekstu działają poprawnie; agenci działają bez pluginu.
- [ ] Alternatywa klawiatura/lista i sprawdzenia spakowanego renderera offline zaliczone.
- [ ] Zależności renderera i licencje oraz zmierzony wpływ na terminal zapisane (≤ NFR-4).
- [ ] `npm run check` + E2E zielone; `THIRD_PARTY_NOTICES.md` zaktualizowane.

## Commity i CHANGELOG

- `test(code-map): measure graph renderers for the visualizer` (plik wyników)
- `feat(code-map): add the Code Map Visualizer plugin`

CHANGELOG (`### Added`):

> **Code Map Visualizer:** explore a project's Code Map — folders and their dependencies, a file's imports and importers,
> a symbol's callers and callees — and jump to the code. Works by keyboard through a list view.

## Pułapki

- Panele dockview z iframe muszą mieć `renderer: 'always'`; iframe dostaje `pointer-events: none` w czasie przeciągania.
- Nie renderuj nigdy całego grafu dużego projektu.
- Nie używaj endpointu HTTP MCP ani jego tokenu z iframe.
