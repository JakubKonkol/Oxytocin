# Etap 02 — enumeracja, watcher i harmonogram

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.3–5.4, 8.5).

## Cel

Host wie, **które pliki** indeksować i **kiedy** je przeindeksować: enumeracja zgodna z Gitem, watcher zarejestrowany
przed skanem, debounce, okresowa rekoncyliacja i kolejka między projektami. Nadal bez UI.

## Wymagania wejściowe

- Etap 01 zrobiony (host, kontrakty, `.oxy`).

## Zakres

W zakresie: FR-BLD-3, FR-BLD-4, FR-BLD-5 (logika wykluczeń), FR-UPD-2…6.

Poza zakresem: parsowanie (etap 03), sygnały „aktywny projekt” w UI (przekazywane już tutaj z main, ale bez UI).

## Zadania

### 2.1 Enumeracja (`src/code-map-host/enumerate.ts`)

- Foldery Gita: `git --no-optional-locks ls-files -z --cached --others --exclude-standard` (te same semantyki co
  `findFiles` w `src/workspace-host/files/project-files.ts`; nie przechodź przez Workspace Host).
- Foldery bez Gita: przejście drzewa świadome `.gitignore` (jeśli istnieje).
- Wykluczenia wbudowane (FR-BLD-4): `.git`, każde `.oxy` na dowolnej głębokości, domyślne `git.ignoredFolders`
  (`node_modules`, `dist`, `build`, `out`…), pliki lock, prawdopodobne sekrety (`.env*`, `*.pem`, `*.key`, `id_rsa*`…),
  pliki binarne (bajt NUL w pierwszych 8 KiB), pliki > 2 MiB. Plus wykluczenia per język z sekcji 8.8 (na razie tylko
  ogólne; językowe dochodzą z ekstraktorami).
- Wykluczenia użytkownika: globy względne (`excludedPaths`).
- Zagnieżdżone repozytoria i submoduły to granice (raportowane jako pominięte korzenie).
- Wynik posortowany stałym porównaniem (kolejność jednostek UTF-16 ścieżki POSIX).

### 2.2 Watcher (`src/code-map-host/watch.ts`)

- Subskrypcja `@parcel/watcher` rejestrowana **przed** pierwszym skanem; zdarzenia buforowane z numerem sekwencyjnym.
- Przepełnienie/błąd watchera → pełna rekoncyliacja; stan świeżości „nieznany” do czasu sprawdzenia.

### 2.3 Harmonogram (`src/code-map-host/scheduler.ts`)

- Debounce 300 ms ciszy, maks. 2 s opóźnienia; scalanie zdarzeń po ścieżce.
- Okresowa rekoncyliacja (FR-UPD-3): co 60 s dla aktywnego projektu i projektów z działającymi terminalami, co 10 min dla
  pozostałych włączonych, pełny audyt hashy co 30 min i przy starcie.
- Wyzwalacze (FR-UPD-5): start, fokus/wybudzenie (zdarzenia `app` przekazywane przez main), zmiany `.gitignore`,
  `tsconfig`/`package.json`, wykluczeń, zmiany HEAD/indeksu.
- Jedna budowa na checkout; globalna kolejka z aktywnym projektem na początku; trwająca budowa nie jest restartowana —
  nowsze zmiany czekają na kolejny przebieg (FR-UPD-6); masowe zmiany (zmiana gałęzi 5000 plików) → jedna rekoncyliacja
  (FR-UPD-4). Rozmiar partii ograniczony tak, by health pingi hosta nadal przechodziły.
- Wszystkie timery jako `Disposable`.

### 2.4 Fingerprinty (`src/code-map-host/fingerprint.ts`)

- Fingerprint stat (rozmiar, mtime, inode/file id) + SHA-256 treści.

### 2.5 Wskazówki aktywności z main

- Main przekazuje hostowi „aktywny projekt” i „projekty z działającymi terminalami” (znane już serwisom
  terminali/aktywności). Kontrakt: nowa metoda RPC `hints:update` w `code-map-host.ts`.

## Testy

- Harmonogram z fake timers: debounce, maks. opóźnienie, scalenie zmiany gałęzi 5000 plików w jeden przebieg, brak pętli
  przebudowy w spoczynku, kolejność aktywny-projekt-pierwszy.
- Fixture enumeracji: ignorowane, nieśledzone, zagnieżdżone repozytorium, sekrety, binarki, duże pliki, folder bez Gita,
  `.oxy` na różnych głębokościach.
- Integracja z prawdziwymi zdarzeniami systemu plików: `tests/integration/code-map-host.test.ts` (edycja, utworzenie,
  usunięcie, zmiana nazwy, zapis atomowy).

## Kryteria ukończenia

- [x] `npm run check` zielone (łącznie z projektem `integration`).
- [x] Brak pętli przebudowy w spoczynku (test).
- [x] Brak zmian widocznych dla użytkownika.

## Implementation decisions

- `ignore` 7.0.13 supplies Gitignore matching for non-Git folders; project scripts and package configurations are never executed.
- `CheckoutIndexer` owns fingerprints and observation; extraction/publication hooks connect stage 03 without retaining all source text in memory.
- Pending watcher/scheduler path sets are bounded to 500; overflow requests full reconciliation. Queue aging prevents a continuously active project from starving another checkout.
- Main activity/focus/resume hints are sent only to a running host. Stage 04 will add the opt-in service that starts it for enabled projects.

## Commity i CHANGELOG

- `feat(code-map): enumerate the files of a checkout`
- `feat(code-map): watch and schedule Code Map updates`
- Bez wpisu w CHANGELOG.

## Pułapki

- Testy z prawdziwym watcherem bywają niestabilne pod obciążeniem — trzymaj je w projekcie `integration`, z rozsądnymi
  timeoutami, a logikę debounce testuj na fake timers w unit.
- Windows: zdarzenia rename przychodzą jako para usunięcie/utworzenie; atomowe zapisy edytorów — jako rename pliku
  tymczasowego.
- Nie zakładaj, że `.gitignore` filtruje sekrety.
