# Etap 04 — serwis w main, IPC i UI (wydanie 1a)

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.1, 5.2, 5.7, 8.2, 8.3).

## Cel

**Pierwsze wydanie widoczne dla użytkownika.** W *Project settings → Code Map* użytkownik włącza Code Map; powstaje
`.oxy/` (domyślnie ignorowany przez Gita), mapa buduje się w tle i jest aktualna; `MAP.md` i `graph.json` są dostępne
dla każdego agenta; działają status, pauza, przebudowa, usuwanie danych i kopiowanie instrukcji dla agentów.

## Wymagania wejściowe

- Etapy 01–03 zrobione.

## Zakres

W zakresie: FR-EN-1…10, FR-DIR (UI i komunikaty), FR-BLD-5 (edytor wykluczeń), FR-BLD-14, FR-UPD-7, FR-AG-6, FR-ST-1…3,
NFR-1…6 (pomiar).

Poza zakresem: narzędzia MCP (etap 06), C# (etap 05), blok w `CLAUDE.md` (etap 07).

## Zadania

### 4.1 Serwis w main

- `src/main/services/code-map/code-map-service.ts` (nowy): czyta `settings.codeMap` z serwisu projektów; konfiguruje i
  usuwa checkouty przy włączeniu/wyłączeniu/zmianie katalogu/usunięciu projektu; trzyma cache statusu; emituje status do
  renderera; po restarcie hosta ponownie wysyła konfigurację; przekazuje wskazówki aktywności (etap 02). Rejestracja w
  bootstrapie main obok innych serwisów (`src/main/index.ts`).
- Uruchamia host leniwie (pierwszy włączony projekt), zatrzymuje, gdy nie ma żadnego.
- Po restarcie aplikacji włączone projekty najpierw przechodzą rekoncyliację (FR-EN-8).

### 4.2 IPC

- Kanały w `src/shared/ipc/channels.ts`: `codeMap:getStatus`, `codeMap:setEnabled`, `codeMap:setOptions` (wykluczenia,
  `ignoreInGit` z decyzją o usunięciu wpisu), `codeMap:rebuild`, `codeMap:pause`, `codeMap:resume`, `codeMap:deleteData`,
  `codeMap:getDiagnostics`; zdarzenie `codeMap:status`.
- Kontrakty zod w `src/shared/ipc/contract.ts` i `src/shared/ipc/events.ts`; handlery przez `src/main/ipc/router.ts`
  (sprawdzenie nadawcy + walidacja); bindingi preload na `window.oxy`.

### 4.3 UI

- `src/renderer/src/features/projects/ProjectSettingsDialog.tsx`: nowa zakładka `code-map` w unii `TabId`;
  `project-settings-model.ts`: draft robi round-trip `codeMap` (zapis dowolnej innej zakładki go zachowuje — test).
- `src/renderer/src/features/projects/settings/CodeMapTab.tsx` (nowy):
  - przełącznik **Enable Code Map** + dialog potwierdzenia (FR-EN-2) z polem **Keep `.oxy` out of Git** (zaznaczone);
  - to samo pole w zakładce, z ostrzeżeniem i propozycją usunięcia wpisu (FR-DIR-9) oraz informacją „`.oxy` is ignored
    by your `.gitignore`”, gdy wpis dodał ktoś inny;
  - blok statusu (FR-ST-1): stan, postęp, liczby, pokrycie per język z poziomem wsparcia, rozmiar, dostęp MCP (z
    istniejących ustawień MCP — na razie „not yet available” do etapu 06);
  - przyciski **Pause updates / Resume updates**, **Rebuild** (anulowalny), **Delete map data** (z potwierdzeniem);
  - edytor wykluczeń (globy, walidacja);
  - lista diagnostyki (ograniczona, przycisk „Copy”);
  - **Copy agent instructions** (tekst z sekcji 8.7, wersja z etapu 04);
  - **Open MAP.md** w edytorze Oxytocin;
  - komunikaty błędów `.oxy` (FR-DIR-7) i „Updated by another Oxytocin instance” (FR-DIR-8).
- `src/renderer/src/features/projects/ProjectItem.tsx`: mały wskaźnik stanu (tylko tokeny CSS), tooltip z
  podsumowaniem, kliknięcie otwiera zakładkę (FR-ST-2).
- Dialog usuwania projektu: jedna linia, że `.oxy/` zostaje w folderze (FR-EN-9).
- Aktualizacje nigdy nie pokazują toastów ani nie kradną fokusu (FR-UPD-7).

### 4.4 Pomiary przed wydaniem

- Eksperyment wydajności (tabela poniżej) na fixture 10 000 plików i na repozytorium Oxytocin → `results/<data>-phase-1.md`.
- Smoke spakowanego buildu Windows: offline, ścieżka ze spacjami i znakami spoza ASCII, bez toolchainu, host startuje,
  gramatyki się ładują.
- Dogfooding na repozytorium Oxytocin przez co najmniej kilka dni.

| Metryka                                       | Cel początkowy (Windows, udokumentowana maszyna)                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Budowa od zera, 10 000 plików                 | < 30 s, z postępem i anulowaniem                                                      |
| Edycja jednego pliku → generacja do zapytań   | p95 < 2 s po ostatnim zdarzeniu                                                       |
| Pamięć hosta                                  | < 512 MiB; zapisz szczyt i pamięć zatrzymaną                                          |
| Spoczynek                                     | brak pętli przebudowy; < 1% jednego rdzenia średnio z 5 min, łącznie ze skanami okresowymi |
| Responsywność terminala/Gita                  | ≤ 10% regresji p95 względem kontrolowanego punktu odniesienia przy tym samym obciążeniu |

Każdy przypadek wielokrotnie; raportuj medianę/p95 i szczyt pamięci, nie najlepszy przebieg. Mierz osobno serializację,
odczyty plików, rozgrzewanie gramatyk, rozwiązywanie i narzut skanów. Gdy cel nie jest spełniony — profiluj i zmień
architekturę albo udokumentowane limity przed wydaniem; nie osłabiaj poprawności dla opóźnień.

## Testy

- Unit: cykl życia serwisu z fałszywym hostem (włączenie → konfiguracja, wyłączenie → usunięcie, zmiana katalogu,
  restart hosta ponawia konfigurację, usunięcie projektu); walidacja IPC odrzuca złe payloady; round-trip `codeMap` w
  modelu ustawień.
- E2E `tests/e2e/code-map.spec.ts`: włączenie na fixture → potwierdzenie → `.oxy/` + wpis w `.gitignore` → Ready →
  `graph.json` ma oczekiwane symbole → edycja + zapis → zaktualizowany graf i `MAP.md` → Pause (edycja niewprowadzona) →
  Resume (wprowadzona) → Rebuild → wyłączenie (brak dalszych aktualizacji) → Delete map data. Dodatkowo: folder bez Gita
  (brak `.gitignore` w katalogu głównym); odznaczona opcja przy włączaniu (brak wpisu, `graph.json` widoczny w
  `git status`, cache i manifest nie); przełączenie opcji wyłącz/włącz w zakładce. Rozszerz E2E ustawień projektu o
  round-trip.
- Macierz `.oxy`/determinizmu (z `README.md` sekcja 8.3 i etap 01/03) — zielona na jobie Windows i w `full-tests`.

Macierz poprawności i odzyskiwania (pokryj testami unit/integration/E2E, zanim wydasz):

| Scenariusz                                            | Wymagany wynik                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pierwsze włączenie, restart, wyłączenie               | Domyślnie wyłączone; włączona mapa się buduje; restart rekoncyliuje; wyłączenie zwalnia pracę.         |
| Ustawienia zapisane z innej zakładki                  | `codeMap` zachowane, łącznie z wykluczeniami; stare pliki projektów ładują się bez błędów migracji.    |
| Edycja, zapis atomowy, nowy nieśledzony, usunięcie, zmiana nazwy | Graf przyrostowy = graf od zera dla tych samych plików; stare węzły/krawędzie znikają.      |
| Zmiana importu/eksportu, tsconfig, package            | Relacje przeliczone, łącznie z niezmienionymi wywołującymi; nieobsługiwane zostają jawne.              |
| Unicode, CRLF, BOM, ścieżki rozróżniające wielkość liter | Zakresy wskazują dokładny tekst; kanoniczne ścieżki nie scalają różnych plików.                     |
| Błąd składni podczas pisania                          | Widoczne częściowe/błędne pokrycie; stara składnia nigdy nie jest raportowana jako świeża.             |
| Edycja o tym samym rozmiarze i mtime, przeoczone zdarzenie | Pełny audyt hashy ją wykrywa; tryb metadanych podaje swoje ograniczenie.                          |
| Zmiana gałęzi, reset/stash                            | Rekoncyliacja aktualizuje graf, łącznie z plikami wcześniej nieśledzonymi/usuniętymi.                  |
| Folder bez Gita; UI Gita wyłączone                    | Mapa dalej obserwuje i buduje się dla wspieranych plików.                                              |
| Zabicie hosta w trakcie parsowania lub publikacji; uszkodzony cache | Ostatnia poprawna generacja czytelna; nieprawidłowe snapshoty przebudowane; main się nie wywraca. |
| Przepełnienie watchera, wybudzenie po uśpieniu        | Zaplanowana rekoncyliacja; świeżość nieznana do sprawdzenia.                                           |
| Wykluczone pliki, traversal, junction poza projekt    | Enumeracja odrzuca ścieżki spoza zakresu; brak wycieku źródła w diagnostyce.                           |
| Ogromny/zniekształcony plik lub graf                  | Limity/watchdog zapobiegają niekontrolowanemu wzrostowi; pokrycie i porady wykluczeń używalne.         |
| Aplikacja zamknięta w czasie zmian plików             | Następne uruchomienie rekoncyliuje; brak twierdzenia o synchronizacji przy zamkniętej aplikacji.       |
| Dwie instancje Oxytocin na jednym projekcie           | Jeden właściciel zapisuje; druga czyta i to komunikuje; przejęcie po nieaktualnym heartbeacie.         |

## Kryteria ukończenia

- [ ] FR-EN, FR-DIR, FR-BLD-1…12 i 14, FR-UPD-1…7, FR-AG-1, FR-AG-6, FR-ST zaimplementowane i pokryte testami.
- [ ] Macierz `.oxy` i determinizmu zielona na Windows CI i w `full-tests`.
- [ ] Eksperyment wydajności zapisany; NFR-1…6 spełnione albo udokumentowane z decyzją.
- [ ] Spakowany build Windows działa offline z dołączonymi parserami, bez toolchainu.
- [ ] Dogfooding na repozytorium Oxytocin; wpis w CHANGELOG bez deklaracji oszczędności.
- [ ] `npm run check` + E2E (`code-map.spec.ts`, ustawienia projektu) zielone; aplikacja buduje się i startuje.

## Commity i CHANGELOG

- `feat(code-map): orchestrate Code Map from the main process` (wewnętrzny)
- `feat(code-map): enable Code Map in Project settings` (widoczny — domyka pętlę)
- `test(code-map): measure the first Code Map release` (plik wyników)

CHANGELOG (`### Added`):

> **Code Map:** enable it in Project settings → Code Map to keep a local, deterministic map of the project's code in
> `.oxy/` (ignored by Git unless you choose otherwise). It updates in the background while Oxytocin runs. Agents can read
> `.oxy/code-map/MAP.md`; copy ready-made agent instructions from the tab. TypeScript and JavaScript symbols, imports and
> calls; other files appear as files.

## Pułapki

- Zakładka nie może zgubić `codeMap` przy zapisie innej zakładki — to najczęstszy błąd w modelach draftu.
- Status przychodzi zdarzeniami (maks. 4/s) — nie trzymaj go w stanie per tick, nie renderuj listy diagnostyki na każdy
  status.
- „MCP on/off” w statusie: do czasu etapu 06 pokaż, że narzędzia agentów jeszcze nie są dostępne — nie obiecuj ich.
