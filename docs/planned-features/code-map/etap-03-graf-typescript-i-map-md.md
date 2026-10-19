# Etap 03 — graf TS/JS, `graph.json` i `MAP.md`

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.3, 5.5, 8.3, 8.4, 8.8).

## Cel

Host buduje z zapisanych plików kompletny, deterministyczny graf dla JavaScript/TypeScript (poziom **Calls**) oraz węzły
plików dla pozostałych plików tekstowych, publikuje `graph.json` i `MAP.md` w `.oxy/code-map/`. Nadal bez UI — etap
kończy się zielonymi fixture i testami determinizmu.

## Wymagania wejściowe

- Etap 02 zrobiony (enumeracja, watcher, harmonogram).
- Decyzja z etapu 00 (Tree-sitter WASM albo TS compiler API dla TS/JS).

## Zakres

W zakresie: FR-BLD-1, 2, 6–12, 14 (dla TS/JS i plików), FR-AG-1, FR-DIR-5, NFR-7.

Poza zakresem: C# (etap 05), zapytania i świeżość dla agentów (etap 06).

## Reguły ekstrakcji i rozwiązywania TS/JS

Rozszerzenia: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` (`.d.ts` indeksowane jako deklaracje, niższy
ranking).

- **Symbole:** funkcje, funkcje strzałkowe i wyrażenia funkcyjne przypisane do `const`, klasy, metody, gettery/settery,
  pola, interfejsy, aliasy typów, enumy, przestrzenie nazw, eksportowane zmienne, eksporty domyślne (nazwane po
  powiązaniu albo `default`), komponenty React (funkcje zwracające JSX oznaczone jako `component`).
- **Importy:** ES `import`/`export … from`, `import type`, `export *`, `import()` z literałem tekstowym, CommonJS
  `require('…')` z literałem tekstowym. Rozwiązywanie: ścieżki względne z lookupem rozszerzeń i `index`
  (`.ts` → `.tsx` → `.d.ts` → `.js` …, plus mapowanie TS ESM `.js` → `.ts`), `tsconfig`/`jsconfig` `baseUrl`, `paths`,
  `extends` (JSONC czytany jako dane), project references; `package.json` `exports`/`main`/`types` dla pakietów workspace
  npm w projekcie; wszystko inne → węzeł pakietu zewnętrznego.
- **Wywołania/referencje:** zakresy leksykalne z przesłanianiem; wywołania zaimportowanych powiązań, funkcji lokalnych,
  `this.method()`, `ClassName.staticMethod()`, `new ClassName()`, JSX `<Component>`; `extends`/`implements`. Wywołania
  metod na wartościach nieznanego typu zostają nierozwiązane (bez inferencji typów w v1). Nigdy nie wnioskuj wywołania
  tylko z tego, że inny plik ma unikalną pasującą nazwę.
- **Nierozwiązane** (z powodem w `unresolved`): nieobsługiwane aliasy, dynamiczne importy bez literału, wywołania
  obliczanych właściwości, dependency injection, szyny zdarzeń, dyspozycja w runtime. `heuristic` tylko dla jawnie
  oznaczonych fallbacków.
- **Lokalizacje:** offsety parsera konwertowane na linie od 1 i kolumny od 0 w UTF-16.

## Zadania

1. `src/code-map-host/parse/runtime.ts` — ładowanie gramatyk (ścieżki z etapu 00, manifest `grammars.json` z
   weryfikacją hashy), pula parserów, watchdog parsowania.
2. `src/code-map-host/extract/typescript.ts` — rekord pliku: symbole ze zakresami i sygnaturami, importy/eksporty (z
   type-only i re-eksportami), miejsca wywołań z wyrażeniem wywoływanym, klauzule dziedziczenia, diagnostyka.
3. `src/code-map-host/extract/files.ts` — rekordy tylko-plikowe dla pozostałych plików tekstowych (język z
   `src/shared/utils/language.ts`, liczba linii).
4. `src/code-map-host/resolve/modules.ts` — rozwiązywanie modułów TS/JS (reguły wyżej), pakiety zewnętrzne jako `package`.
5. `src/code-map-host/resolve/bindings.ts` — zakresy leksykalne, przesłanianie, zaimportowane powiązania, wywołania
   członków klasy przez `this`, importy przestrzeni nazw; reszta `unresolved` z powodem.
6. `src/code-map-host/graph/build.ts` — złożenie rekordów w grupy, węzły i krawędzie; deterministyczne ID i sortowanie;
   limity z FR-BLD-12 (stan `limit` zamiast cichego obcięcia); pokrycie (FR-BLD-10); błąd składni zachowuje ostatnie
   dobre symbole pliku oznaczone jako nieaktualne (FR-BLD-11). W v1 każda aktualizacja rozwiązuje cały graf od nowa z
   cache rekordów (sekcja 8.5, punkt 5).
7. `src/code-map-host/map-md.ts` — renderer `MAP.md` (sekcje i kolejność z sekcji 8.3), budżet 32 KiB, obcinanie całymi
   liniami, deterministyczny ranking, poziomy wsparcia per język (FR-BLD-14).
8. Publikacja przez `writer.ts` z etapu 01; po każdej udanej publikacji przycinanie cache.

## Testy

- **Fixture** `tests/fixtures/code-map/<nazwa>/` — małe, oryginalne repozytoria z ręcznie przejrzanym `expected.json`:
  przesłanianie, funkcje o tych samych nazwach, łańcuchy re-eksportów, aliasy ścieżek (`paths`/`baseUrl`/`extends`),
  workspace npm, CRLF/BOM/Unicode, błędy składni, cykle importów, komponenty JSX, `require`, `import()`.
- **Precision/recall** importów i wywołań per fixture (zapisz liczby w pliku wyników przy etapie 04).
- **Determinizm:** przetasowana enumeracja; budowa od zera vs przyrostowa po edycjach/usunięciach/zmianach nazw; ścieżki w
  stylu Windows i CRLF → bajtowo identyczne `graph.json` i `MAP.md` (job Windows w CI i macierz `full-tests`).
- **`MAP.md`:** golden files dla fixture, egzekwowanie budżetu, brak treści kodu i komentarzy, determinizm.
- **Skan prywatności:** `graph.json`, `MAP.md` i rekordy cache nie zawierają ścieżek absolutnych, nazwy użytkownika ani
  znaczników czasu (FR-DIR-5).
- Dodawaj fixture regresyjny dla każdego błędu resolvera zamiast snapshotować cały wynik implementacji.

## Kryteria ukończenia

- [x] Wszystkie fixture TS/JS zielone; liczby precision/recall policzone.
- [x] Testy determinizmu zielone na Windows i Linux.
- [x] Limity ochronne dają stan `limit` (test z fixture blisko limitu — limity można obniżyć w teście).
- [x] Brak zmian widocznych dla użytkownika.

## Commity i CHANGELOG

Po jednym commicie na zagadnienie, np.:

- `feat(code-map): load bundled Tree-sitter grammars`
- `feat(code-map): extract TypeScript and JavaScript declarations`
- `feat(code-map): resolve TypeScript modules and bindings`
- `feat(code-map): assemble and publish the deterministic graph`
- `feat(code-map): render MAP.md`

Bez wpisu w CHANGELOG (nic widocznego).

## Pułapki

- Nie polegaj na kolejności `Map`/listingu katalogu — sortuj jawnie.
- `web-tree-sitter` 0.27.1 exposes string indices and columns in UTF-16 units (verified with an astral Unicode character before a declaration). Preserve these positions; do not apply a second byte-to-UTF-16 conversion. Native Tree-sitter byte offsets are a separate API.
- `tsconfig.json` to JSONC (komentarze, przecinki na końcu) — parsuj tolerancyjnie, nigdy nie wykonuj.
- Klucz cache musi zawierać wersję ekstraktora.
