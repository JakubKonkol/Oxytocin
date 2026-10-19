# Etap 00 — spike parsera i pakowania

> Część planu [Code Map](README.md). Przed rozpoczęciem przeczytaj cały `README.md`, w szczególności sekcje 8.1 i 8.8.

## Cel

Podjąć **na podstawie pomiarów** decyzję o runtime parsera i sposobie pakowania gramatyk. Etap nie zmienia produktu:
jego wynikiem jest plik `results/<RRRR-MM-DD>-parser-spike.md` i (tymczasowy) skrypt prototypu.

## Wymagania wejściowe

- Brak (pierwszy etap). Stan repozytorium: Oxytocin 0.9.10 lub nowszy.

## Zakres

W zakresie:

- prototyp `web-tree-sitter` 0.27.1 z gotowymi gramatykami WASM: JavaScript, TypeScript, TSX i C# (pomiar), plus test
  „załaduj i sparsuj” dla Go, Java i Python;
- prototyp ekstrakcji TS/JS przez TypeScript compiler API (`ts.createSourceFile`, tylko składnia) jako fallback;
- pomiary w `utilityProcess` Electrona, w buildzie deweloperskim i spakowanym na Windows;
- projekt kroku kopiowania gramatyk i manifestu `grammars.json`.

Poza zakresem: jakikolwiek kod produkcyjny Code Map, UI, zapis do `.oxy`.

## Zadania

1. **Prototyp Tree-sitter.** Skrypt `scripts/code-map-parser-spike.ts` (tymczasowy) uruchamiany w Electron
   `utilityProcess`, ładujący `.wasm` z wyjścia builda (dev) i z `resources/code-map/grammars/` (spakowany build).
   Parsuje pliki i liczy deklaracje (bez rozwiązywania) — wystarczy do pomiaru przepustowości.
2. **Prototyp TypeScript compiler API** dla TS/JS (`ts.createSourceFile`, bez programu i typecheckera). C# nie ma
   fallbacku (Roslyn wymaga toolchainu .NET — poza zakresem), więc gramatyka C# musi przejść.
3. **Fixture 10 000 plików.** Generator w `scripts/make-fixtures.ts` (ten plik już istnieje — dopisz generator
   repozytorium TS z realistyczną strukturą importów; generator może potem posłużyć benchmarkowi etapu 04).
4. **Pomiary** na repozytorium Oxytocin i na fixture 10 000 plików: przepustowość parsowania od zera, pamięć, rozmiar
   paczki, czas startu, czas ładowania gramatyki C# (5,35 MB) i czy gramatyki ładować leniwie per język. Warunki: build
   dev i spakowany Windows; offline; ścieżka ze spacjami i znakami spoza ASCII; maszyna bez kompilatora.
5. **Wersje, licencje, ABI.** Sprawdź dokładne wersje i licencje oraz parowanie ABI runtime ↔ każda gramatyka (gramatyki
   generowano różnymi wersjami Tree-sitter CLI). Gramatyka, która się nie ładuje, jest przebudowywana z przypiętego
   źródła odpowiednią wersją CLI w udokumentowanym, powtarzalnym skrypcie — albo przesunięta na później.
6. **Projekt pakowania.** Pakiety gramatyk jako devDependencies (ich skrypty instalacyjne **nie** są zatwierdzane w
   `allowScripts`); kopiowanie `.wasm` do `resources/code-map/grammars/` z manifestem `grammars.json`
   (`package`, `version`, `file`, `sha256`, `license`) weryfikowanym przy buildzie; noty licencyjne generowane z
   manifestu (`scripts/generate-notices.ts`). Sprawdź, czy `.wasm` musi być w `asarUnpack` (`electron-builder.yml`).
7. **Decyzja** zapisana w pliku wyników: Tree-sitter WASM dla wszystkich języków (rekomendacja — wymagany i tak dla C#,
   jeden framework) albo TypeScript compiler API dla TS/JS + Tree-sitter dla reszty.

## Reguła decyzji

- Domyślnie: Tree-sitter WASM.
- Jeśli WASM nie spełnia NFR-1 (budowa 10 000 plików < 30 s) o więcej niż 2× — najpierw profiluj. Jeśli nadal nie
  spełnia — TS compiler API dla TS/JS, Tree-sitter dla C# i etapu 11.

## Testy

Etap nie dodaje testów produktu. Skrypt spike'u może zostać usunięty albo przerobiony na benchmark etapu 04 (wtedy
dostaje własny test uruchomienia w `scripts/`).

## Kryteria ukończenia

- [ ] Spakowany build Windows parsuje fixture offline, bez toolchainu.
- [ ] Liczby (przepustowość, pamięć, rozmiar, start, ładowanie C#) zapisane w `results/<data>-parser-spike.md` z
      rewizją, maszyną, wersjami Electron/Node i gramatyk.
- [ ] Decyzja o runtime i o układzie pakowania (ścieżka, `asarUnpack`, ładowanie leniwe) zapisana w pliku wyników.
- [ ] Wszystkie licencje gramatyk i runtime potwierdzone jako MIT.
- [ ] Tabela w sekcji 8.8 `README.md` poprawiona, jeśli wersje lub rozmiary się zmieniły.

## Commity i CHANGELOG

- `docs(code-map): record the parser spike results` (plik wyników, ewentualne poprawki planu).
- Prototyp nie trafia na `main` jako kod produkcyjny; jeśli zostaje jako benchmark — osobny commit `test(code-map): …`.
- Bez wpisu w CHANGELOG (nic widocznego).

## Pułapki

- Natywne bindingi w pakietach gramatyk: nie zatwierdzaj ich skryptów w `allowScripts`, potrzebny jest tylko `.wasm`.
- `web-tree-sitter` w `utilityProcess` musi znaleźć swój własny `.wasm` runtime (`locateFile`) — w spakowanym buildzie
  ścieżki różnią się od dev.
- Nie mierz w procesie main ani w rendererze — wynik nie przeniesie się na hosta.
