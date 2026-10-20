# Etap 08 — wycinki grafu i publiczne API `oxy.codeMap` (plugin API 0.2.0)

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.6 FR-VIS-8/13, 8.9).

## Cel

Rdzeń udostępnia pluginom ograniczone wycinki grafu przez nowy, wersjonowany namespace `oxy.codeMap` z uprawnieniem
`code-map.read`. To fundament wizualizatora (etap 09), ale API jest publiczne i użyteczne samo w sobie.

## Wymagania wejściowe

- Etap 06 zrobiony (silnik zapytań w hoście).

## Zakres

W zakresie: wycinki `overview` / `file` / `neighborhood` (+ `impact` w etapie 10), API pluginów, uprawnienie, dokumentacja.

Poza zakresem: sam plugin wizualizatora (etap 09), `code-map.knowledge.read` (etap 14).

## Zadania

### 8.1 Wycinki w hoście

- `src/code-map-host/query/slice.ts`: `overview` (grupy folderów z zagregowanymi liczbami `imports`/`references`,
  rozwijalne), `neighborhood`, `file`; limity 150/300 domyślnie, 500/1000 twardo, 512 KiB payloadu; przyczyny obcięcia;
  wszystkie liczby z tej samej generacji; `SNAPSHOT_CHANGED` dla rozwinięć starej generacji. Kontrakt `GraphSliceRequest`
  z sekcji 8.9.
- Członkostwo w grupie (`contains`) oddzielone od zależności import/call; brak syntetyzowanych celów dla nierozwiązanych.

### 8.2 Publiczne API

- `packages/plugin-api/index.d.ts`: namespace `oxy.codeMap` — `listCheckouts(projectId)`, `status(ref)`,
  `query(request, { signal })` (search / outline / relations / slice), `onDidChange(listener)` (tylko unieważnienia),
  `openSource(locator)`; podbicie wersji do **0.2.0** i wpis w `packages/plugin-api/CHANGELOG.md`;
  `src/shared/constants.ts` `OXYTOCIN_API_VERSION`.
- `src/shared/domain/plugin.ts`: uprawnienie `code-map.read` z opisem.
- `src/plugin-host/api.ts` (fasada) i `src/main/services/plugins/plugin-host-service.ts` (dispatch): oba sprawdzają
  uprawnienie i opt-in projektu przy każdej operacji; walidacja żądań/wyników (zod); anulowanie; odwołanie przy
  wyłączeniu.
- `openSource`: rozwiązuje aktualny lokalizator i deleguje do istniejącej nawigacji edytora (`ui.openInEditor`);
  konwertuje kolumny 0-based UTF-16 na konwencję adaptera edytora (test konwersji); odrzuca wykluczone/uciekające ścieżki
  i nieaktualne zakresy.
- Pluginy dostają ID checkoutów wyłącznie z API — nie mogą wymyślić ścieżki worktree, włączyć indeksowania zapytaniem ani
  wrócić do aktywnego projektu, gdy checkout zniknie.
- `docs/plugins/README.md`: dokumentacja namespace i uprawnienia.

## Testy

- Zagregowane liczby krawędzi = liczba krawędzi bazowych w zakresie; limity; cykle; huby o dużym stopniu; determinizm
  wycinków.
- Nieautoryzowany plugin fixture odrzucany; wyłączony projekt odrzucany; oczekujące żądanie anulowane przy wyłączeniu;
  późne odpowiedzi po zmianie generacji → `SNAPSHOT_CHANGED`.
- Ten sam wycinek fixture przez MCP i przez plugin zgadza się co do tożsamości węzłów, relacji, proweniencji i pokrycia
  (z uwzględnieniem różnych budżetów).

## Kryteria ukończenia

- [x] API, wersja, sprawdzanie możliwości, uprawnienia, nawigacja do źródła i dostarczanie unieważnień udokumentowane i
      przetestowane.
- [x] `npm run check` zielone.

## Commity i CHANGELOG

- `feat(code-map): serve bounded graph slices`
- `feat(plugins): Code Map API for plugins (plugin API 0.2.0)`

CHANGELOG (`### Added`):

> **Plugin API 0.2.0:** `oxy.codeMap` (permission `code-map.read`) — list a project's Code Map checkouts, read its status,
> query bounded graph slices, outlines and relations, follow changes and open source locations.

## Pułapki

- Uprawnienie ogranicza wywołania API — nie sandboxuje kodu Node pluginu; nie pisz, że jest inaczej.
- Limit wycinka pluginu nie zwiększa budżetów odpowiedzi dla agentów.
