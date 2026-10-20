# Etap 06 — silnik zapytań i narzędzia MCP

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.4 FR-UPD-8, 5.5, 8.6, 8.7).

## Cel

Agenci połączeni z MCP Hub Oxytocin dostają pięć narzędzi Code Map ze świeżymi, ograniczonymi odpowiedziami i ścisłym
wyborem checkoutu. Wydanie samodzielne.

## Wymagania wejściowe

- Etap 04 wydany (mapa na dysku i w hoście). Etap 05 nie jest wymagany (narzędzia działają dla każdego wspieranego
  języka).

## Zakres

W zakresie: FR-AG-2, 3, 4 (bez worktree — te w etapie 07), 5, 8; FR-UPD-8; NFR-3.

Poza zakresem: worktree i most Ensemble (etap 07), blok w `CLAUDE.md` (etap 07), wycinki dla wizualizatora (etap 08).

## Zadania

### 6.1 Silnik zapytań w hoście

- `src/code-map-host/query/search.ts`: indeks w pamięci per checkout — dzielenie identyfikatorów (camelCase/snake_case),
  segmenty ścieżek, terminy z sygnatur, premie za dokładną nazwę/ścieżkę, niższy ranking plików testowych, różnorodność
  między plikami; deterministyczne rozstrzyganie remisów.
- `src/code-map-host/query/outline.ts` — eksporty, definicje, importy pliku ze zakresami.
- `src/code-map-host/query/relations.ts` — ograniczone BFS (odwiedzone węzły 2000 / krawędzie 5000), filtr proweniencji
  (`includeHeuristic`), kierunek, typy relacji, `whyIncluded`.
- `src/code-map-host/query/repo-map.ts` — sekcje `MAP.md` dla `pathPrefix`.
- `src/code-map-host/query/freshness.ts` — opróżnianie zdarzeń, próba metadanych, czekanie ≤ 2 s, tryby `latest` /
  `allow-stale` / `verified`, wynik `INDEX_UPDATING` (sekcja 8.6).
- Fragmenty źródła czytane z dysku tylko po ponownym sprawdzeniu hasha pliku.
- Metody RPC `query:*` w `src/shared/rpc/contracts/code-map-host.ts` z anulowaniem; czytelnik przypina generację na cały
  czas żądania.

### 6.2 Narzędzia MCP

- `src/main/services/mcp/code-map-tools.ts` (nowy): `oxy_code_map_status`, `oxy_repo_map`, `oxy_find_code`,
  `oxy_file_outline`, `oxy_code_relations` — wejścia i limity z sekcji 8.7; zod wejście/wyjście; budżety znaków; polityka
  tylko-do-odczytu; listowane tylko, gdy co najmniej jeden projekt ma włączone Code Map (powiadomienie o zmianie listy);
  każde wywołanie ponownie sprawdza, że wybrany projekt jest włączony.
- `src/main/services/mcp/caller-context.ts`: ścisłe rozwiązywanie checkoutu **tylko dla narzędzi Code Map**: mapowanie
  terminala → jawne `cwd` → jawny `project`; nigdy aktywny projekt UI; sprzeczne selektory odrzucane; niezarejestrowane
  ścieżki nie wywołują indeksowania.
- `src/main/services/mcp/mcp-hub.ts`: podłączenie buildera; krótki akapit o Code Map w instrukcjach inicjalizacji, gdy
  projekt wołającego ma Code Map (FR-AG-5).
- Logi: czasy i liczby, nigdy treść kodu ani tokeny (FR-AG-8). Tekst źródłowy w wynikach to dane.
- Zakładka Code Map: status dostępu MCP pokazuje teraz rzeczywisty stan (z istniejących ustawień MCP) i link do
  konfiguracji Agent Tools, gdy MCP jest wyłączone; tekst **Copy agent instructions** w wersji z narzędziami (sekcja 8.7).

## Testy

- Ranking na oznaczonych fixture (recall@8 względem oczekiwanych plików).
- Limity i flagi obcięcia; `BUDGET`/`truncated`; walidacja wejścia (długości, zakresy).
- Wyścigi świeżości: zapytanie w trakcie budowy, edycja tuż przed zapytaniem; anulowanie jednego wołającego nie anuluje
  wspólnego odświeżenia; 10 równoczesnych zapytań przy edycjach → jedna budowa, spójne odpowiedzi.
- `code-map-tools.test.ts`: wyłączony projekt odrzucany nawet przy zcache'owanej liście narzędzi; nigdy odpowiedź z innego
  projektu; dwa projekty z nakładającymi się katalogami.
- Rozszerzenie `tests/integration/mcp-hub.test.ts`: prawdziwe wywołania HTTP na fixture mapy.
- E2E (`tests/e2e/code-map.spec.ts`): deterministyczny fałszywy klient MCP — zapytanie → edycja → zapytanie widzi edycję
  → wyłączenie → odmowa. Bez płatnego modelu w CI.

## Kryteria ukończenia

- [x] Pięć narzędzi działa przez istniejący Hub; agenci mają zwięzłe wskazówki.
- [x] Ścieżki świeżości i stale/error są jawne; brak „no matches” z niepełnego indeksu.
- [x] Ciepłe zapytania p95 < 200 ms (small fixture only; `results/2026-10-20-mcp-tools.md`).
- [ ] Ręczny test z Claude Code i Codex CLI zapisany w pliku wyników (wersje klientów, czy znalazły i użyły narzędzi).
- [ ] `npm run check` + integracja + E2E zielone.

## Commity i CHANGELOG

- `feat(code-map): answer bounded Code Map queries in the host` (wewnętrzny)
- `feat(code-map): offer Code Map tools to agents over MCP`

CHANGELOG (`### Added`):

> **Code Map for agents:** agents connected to Oxytocin's MCP server get `oxy_find_code`, `oxy_file_outline`,
> `oxy_code_relations`, `oxy_repo_map` and `oxy_code_map_status` for projects with Code Map. Answers are bounded and say
> how fresh they are.

## Pułapki

- Lista narzędzi to nie autoryzacja — każde wywołanie sprawdza aktualny stan projektu.
- Nie zmieniaj zachowania istniejących narzędzi rdzenia przy wprowadzaniu ścisłego wyboru checkoutu.
- Token Hub daje szeroki dostęp — nie twierdź w dokumentacji ani UI, że izolujesz agentów.

## Implementation notes (2026-10-20)

The host exposes validated `query:run` / `query:cancel` RPC methods. Source snippets are optional and deliberately not
emitted: results contain indexed signatures/ranges, and agents read current source separately. This avoids returning
source from a different revision. Unchanged metadata audits reuse the immutable graph and its search/adjacency indexes.
Manual CLI sessions remain unmeasured. App E2E was added but cannot run in this Windows session without Docker/WSL;
the user authorized committing with available checks and this documented exception. See the results report.
