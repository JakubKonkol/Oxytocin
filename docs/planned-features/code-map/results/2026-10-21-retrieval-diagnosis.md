# Code Map: koszt wyszukiwania i czytelność grafu

Sprawdzone 2026-10-21 na działającym MCP Oxytocina oraz na lokalnym indeksie projektu.
Wersja odniesienia: `7c4f694d949b12238ede33fffb19f1fe3c842b7a`.
Surowe wyniki: [2026-10-21-retrieval.json](2026-10-21-retrieval.json).
Nowy visualizer: [zrzut rzeczywistego grafu usług](2026-10-21-visualizer.png).

## Diagnoza

1. **Koszt obowiązkowego wejścia.** Generowane instrukcje nakazywały najpierw czytać `MAP.md`, potem pobrać kontekst i używać kolejnych narzędzi strukturalnych. Mapa tego projektu miała ponad 500 wierszy. Nawet pytanie o jedną konfigurację zaczynało się od szerokiego kontekstu repozytorium. Ogólne instrukcje serwera są też prezentowane agentowi wraz z narzędziami, więc ich długość ma dodatkowy koszt.
2. **Nietrafny ranking.** Każde dopasowane słowo miało tę samą wagę, niezależnie od tego, czy pochodziło z nazwy symbolu czy wspólnego katalogu. Remisy rozstrzygała kolejność ścieżek. Wywołane na żywo `oxy_find_code("code map configuration")` wskazało dokumenty `docs/planned-features/code-map/...`, zamiast konfiguracji. Dopasowanie było sumą pojedynczych słów, bez normalizacji `configuration`/`settings` i bez odfiltrowania słów pytania.
3. **Kontekst wypełniał budżet.** `taskContext` szukał 30 wyników, dokładał sąsiedztwo pierwszego trafienia i wykorzystywał wolne miejsce na kolejne węzły. Pusty zbiór learnings nie ograniczał odpowiedzi. Zwykłe pytanie mogło więc generować prawie 8000 znaków danych.
4. **Format inspekcyjny trafiał do agenta.** MCP serializował całe struktury przeznaczone również do inspekcji: identyfikatory zawierające ścieżkę, osobną ścieżkę, podpisy, hashe, punktację i powtarzalne wyjaśnienia. Nie wszystkie te pola pomagają znaleźć kod. W zapytaniu o relacje mechanizm redukcji budżetu usuwał krawędzie przed węzłami — w próbie na żywo zostały cztery węzły i zero połączeń.
5. **Visualizer nie wykorzystywał topologii.** Sztywna siatka nie grupowała powiązanego kodu, wszystkie krawędzie wyświetlały etykiety, a tabela i rozbudowane kontrolki stale zajmowały znaczną część miejsca.

To potwierdza realne źródła narzutu. Nie odtwarza dokładnie zgłoszonego rachunku Claude'a: nie mamy oryginalnego pytania, przebiegu obu sesji ani danych usage. Nie należy utożsamiać rozmiaru odpowiedzi narzędzia z całkowitym kosztem sesji modelu.

## Porównanie z projektami źródłowymi

[Trail-Code](https://github.com/trailhq/Trail-Code#search--orient-trail-grep--trail-map) rozdziela ograniczony ranking trafień od wyszukiwania wszystkich wystąpień. `trail map` stosuje budżet i skupia się na katalogach oraz węzłach o dużej liczbie zależności; `trail grep` grupuje wystąpienia według symbolu. Wniosek dla Oxytocina: mapa ma skracać dojście do kodu, a szeroka orientacja nie powinna być obowiązkowym etapem każdego wyszukania. Opcjonalny [głębszy kontekst](https://github.com/trailhq/Trail-Code/blob/main/src/context/build.ts) jest osobną, cache'owaną ścieżką, korzystającą z modelu; nie dodawaliśmy takiego kosztu do lokalnego indeksowania.

[Graphify CLI](https://github.com/Graphify-Labs/graphify/blob/v8/graphify/cli.py) przekazuje do zapytania budżet, zakres i kotwice, zwracając tekst wybranego podgrafu. Jego wskazówki dla Gemini odróżniają zwięzłe zapytanie od raportu architektury. Wniosek: szczegóły należy odsłaniać na żądanie i zachować informację o pochodzeniu krawędzi. Oxytocin nadal pokazuje `syntax`/`binding`/`heuristic`, aktualność i ograniczenia pokrycia. Nie przejęto wymuszania dodatkowego wywołania grafu przed każdym odczytem pliku.

## Wprowadzone zmiany

- Instrukcje proponują `oxy_find_code` **albo** `oxy_task_context`, po czym odczyt wskazanego źródła. Mapa, outline i relacje są opcjonalne; dla literałów i słabych wyników zalecane jest zwykłe wyszukiwanie. Przy otwarciu indeksu aktualizują się wyłącznie rozpoznane, wcześniej dodane bloki. Własne instrukcje, zmodyfikowane bloki i pliki nieobjęte wcześniejszą konfiguracją pozostają bez zmian.
- Domyślny budżet pliku mapy spadł z 32 do 6 KiB. Pliki testowe nie są automatycznie deklarowane punktami wejścia aplikacji.
- Ranking uwzględnia rzadkość słów, ich obecność w nazwie deklaracji, pokrycie pytania i niewielki słownik konfiguracji po angielsku/polsku. Dokładny identyfikator lub ścieżka zwraca dokładne dopasowania, bez dopełniania przypadkowymi symbolami. Dokumentacja jest nadal dostępna, ale zwykłe dopasowanie katalogu nie wypiera deklaracji.
- Kontekst domyślnie wybiera sześć trafień (`limit`, maksymalnie 30). Sąsiedztwo dołączane jest dla kotwic lub pytań o zależności; ma osobny przydział miejsca i najwyżej cztery początkowe krawędzie. Indeks sąsiedztwa powstaje dopiero wtedy, gdy jest potrzebny.
- MCP domyślnie zwraca krótki tekst z lokalizacją i `symbolId`. `format: "json"` udostępnia pełny dotychczasowy format. Status diagnostyczny pozostaje pełny. Stan indeksu, stale, metoda weryfikacji, pokrycie, nierozwiązane relacje i obcięcie są nadal widoczne. Pełne treści learnings, ich rewizje, dowody i receipt pozostają zachowane. Formatowanie nie przekracza już wymuszonego budżetu odpowiedzi.
- Redukcja budżetu relacji usuwa węzeł razem z jego połączeniami, zachowując użyteczny fragment grafu.
- Visualizer ma duże płótno, układ siłowy uwzględniający wymiary etykiet, kolory typów, podświetlanie sąsiedztwa i panel kierunkowych połączeń. Outline i dodatkowe filtry są otwierane na żądanie. Kamera i pozycje są zachowywane przy przełączaniu graf/lista; zmiana rozmiaru panelu aktualizuje canvas.

## Pomiary

Ten sam zapis grafu podano implementacji z poprzedniego commita i nowemu kodowi. Zawierał 1158 plików i 14021 symboli. Liczby poniżej oznaczają **znaki całej odpowiedzi**, nie tokeny ani koszt modelu; metadane kontrolne są jednakowe po obu stronach. Pamięć learnings jest pusta, więc jest to pomiar wyszukiwania kodu.

| Pytanie | Find przed → po | Task context przed → po |
|---|---:|---:|
| code map configuration | 2760 → 1538 | 7601 → 1668 |
| Gdzie w aplikacji mamy konfigurację code map | 2760 → 1538 | 7601 → 1668 |
| getSettings | 3323 → 372 | 7892 → 556 |
| terminal profiles | 3726 → 2043 | 7584 → 1961 |
| CodeMapService | 3750 → 368 | 7668 → 552 |
| where is MCP server configuration | 3270 → 1615 | 7892 → 1591 |

W tej próbie odpowiedzi task-context zmalały o **74–93%**. Mapa zmalała z 27149 do 6043 bajtów. Nowy przepływ nie wymaga jej czytania przy tych pytaniach. Dla pytania o konfigurację pierwszym wynikiem jest teraz `src/shared/domain/code-map.ts:CodeMapSettings`, a w pierwszej czwórce jest również ekran `CodeMapTab.tsx`.

Dodatkowa kontrola `rg -n -F`, bez testów i plików spec, w `src`: `getSettings` dało 2185 znaków, `CodeMapService` 1588. Odpowiadające im wyniki `oxy_find_code` mają 372 i 368 znaków. Zakresy nie są identyczne: ripgrep zwraca wystąpienia, a graf definicje. Gdy potrzebne są wszystkie wystąpienia albo lokalizacja jest już znana, ripgrep/bezpośredni odczyt nadal może być właściwszy. Nie deklarujemy uniwersalnej oszczędności ani wyniku płatnego A/B agentów.

Powtórzenie pomiaru (indeks musi już istnieć):

```sh
npx tsx --tsconfig tsconfig.node.json scripts/code-map-retrieval-benchmark.ts
```

Opcjonalne argumenty: pełny hash zaufanego lokalnego commita bazowego i ścieżka do zapisanego `graph.json`. Skrypt zapisuje hash grafu, pełne listy wyników, rozmiary i komendy porównania do `test-results/code-map-retrieval.json`. Benchmark pełnych sesji wraz z rzeczywistym usage pozostaje w `scripts/code-map-agent-evaluation.ts`; ten raport nie zastępuje takiego eksperymentu.

## Weryfikacja i ograniczenia

- Typecheck całego workspace, ESLint zmienionych plików, testy podsystemu code-map i integracja HTTP MCP.
- Regresje dla konfiguracji po angielsku/polsku, dokładnych identyfikatorów, limitu kontekstu, zachowania krawędzi przy małym budżecie, zwięzłego formatu, receiptów oraz migracji instrukcji.
- Zbudowany plugin testowany w Chromium w izolowanym iframe: wyszukiwanie, klawiatura, otwieranie źródła, odświeżanie, widoczność, zmiana projektu, rzeczywisty graf usług, zaznaczenie i wąski panel. Bez żądań do zewnętrznych serwerów.
- Działający host podczas diagnozy korzystał z poprzedniego buildu. Nowe adaptery przeszły lokalne testy i integrację HTTP; uruchomienie nowej wersji aplikacji aktywuje je w bieżącym projekcie i odświeży rozpoznane bloki instrukcji.
- Aktualność indeksu nie oznacza pełnej semantyki: na żywo raportowano dwa niepełne odczyty TSX (`plugins/task/src/views/task.tsx`, `CommitBox.tsx`) i około 38 tys. nierozwiązanych wywołań. Typecheck projektu przeszedł; są to ograniczenia parsera/resolvera, nie dowód błędów składni aplikacji. Nie usuwamy tej informacji w celu pozornej oszczędności. Wyszukiwanie pozostaje leksykalne, bez embeddingów ani modelu.

## Final verification after resuming

- Workspace typecheck, ESLint and Prettier passed. Production app and bundled plugins built successfully.
- Focused Code Map suite: 153 passed, 4 skipped. HTTP MCP integration: 4 passed.
- Full `npm run check`: 1437 unit tests passed, 6 skipped; one lifecycle test exceeded its 5-second timeout while E2E was also running. The lifecycle and agent-context files then passed separately (20 passed, 1 skipped). The full check did not proceed to its integration, latency or license stages.
- Chromium smoke passed with no page errors or external requests; the screenshot above was refreshed from this run.
- The first two Electron E2E tests passed (learning receipts and keyboard/source navigation, including graph/outline switching). The remaining E2E run was stopped at the user's request; the user will run it separately.
- Added explicit truncation reporting for the task-context search limit and updated E2E clients that parse JSON to request `format: "json"`.
