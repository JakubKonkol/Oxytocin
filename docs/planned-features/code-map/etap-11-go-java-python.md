# Etap 11 — Go, Java i Python

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcja 8.8) i etap 05 (wzorzec dla języka z typami).

## Cel

Kolejne języki „tam, gdzie to nieskomplikowane” (decyzja właściciela): gotowe gramatyki WASM czynią ekstrakcję małą, a
Go i Java mają jawne systemy modułów; Python osiąga poziom Imports z prostymi wywołaniami. **Jedno wydanie na język**, w
kolejności: Go → Java → Python. Rust i PHP później, na żądanie, według tej samej checklisty.

## Wymagania wejściowe

- Etap 04 wydany (etap 11 nie zależy od etapów 05–10 i może iść równolegle).

## Checklista każdego języka

1. Gramatyka dodana do `grammars.json` z hashem i licencją; noty licencyjne zaktualizowane.
2. Domyślne wykluczenia języka (sekcja 8.8).
3. Ekstraktor `src/code-map-host/extract/<język>.ts` i resolver `src/code-map-host/resolve/<język>.ts`.
4. Fixture `tests/fixtures/code-map/<język>-*` z ręcznie przejrzanymi oczekiwaniami; precision/recall; determinizm
   (przetasowanie, CRLF, warianty wielkości liter); wydajność na wygenerowanym fixture; smoke spakowanego buildu offline.
5. Poziom wsparcia w UI i `MAP.md`; krótki opis ograniczeń.
6. Linia w CHANGELOG. Żaden język z samymi węzłami plików nie jest prezentowany jako „wspierany”.

## Go (wydanie 11a)

- **Moduły:** `go.mod` daje ścieżkę modułu; pakiet = katalog; `go.work` dodaje moduły workspace.
- **Symbole:** funkcje, metody z typem odbiorcy, struktury, interfejsy, definicje/aliasy typów, stałe, zmienne;
  eksportowane = nazwa z wielkiej litery.
- **Importy:** ścieżka importu → katalog w module lub workspace; biblioteka standardowa i inne moduły → węzły pakietów.
  Pliki `_test.go` to testy; build tagi zapisywane, nie ewaluowane.
- **Wywołania:** `pkg.Func()` przez nazwę/alias importu, wywołania w tym samym pakiecie, `recv.Method()`, gdy `recv` ma
  zadeklarowany typ albo typ literału złożonego; wywołania metod interfejsów nierozwiązane (bez inferencji implementacji).
- Fixture: dwa moduły w workspace (`go.work`).
- CHANGELOG: „**Code Map:** Go support — modules and packages, declarations, imports and calls.”

## Java (wydanie 11b)

- **Pakiety:** deklaracja `package`; korzenie źródeł z `src/main/java`, `src/test/java` albo folderu zgodnego ze ścieżką
  pakietu; moduły `pom.xml`/`settings.gradle(.kts)` jako grupy (czytane jako tekst/XML, nigdy uruchamiane).
- **Symbole:** klasy, interfejsy, enumy, rekordy, adnotacje, metody, konstruktory, pola; widoczność.
- **Importy:** pojedynczy typ, wildcard (`a.b.*` — rozwiązany tylko przy dokładnie jednym kandydacie), importy statyczne;
  typy z tego samego pakietu bez importu.
- **Wywołania/referencje:** jak w C#: zadeklarowane typy pól, parametrów i lokalnych (`var` z `new`), wywołania
  statyczne, `this`/`super`, `extends`/`implements`; przeciążenia po liczbie argumentów.
- Fixture: wielomodułowy układ Maven.
- CHANGELOG: „**Code Map:** Java support — packages and modules, declarations, imports and calls.”

## Python (wydanie 11c)

- **Korzenie pakietów:** katalog projektu, układ `src/`, foldery z `pyproject.toml` (`[tool.setuptools]`, `packages`,
  Poetry `packages`) i foldery z `__init__.py`; namespace packages bez `__init__.py` wspierane pod wykrytym korzeniem.
- **Symbole:** moduły, klasy, funkcje, metody, przypisania na poziomie modułu (stałe), dekoratory zapisane na symbolu;
  `__all__` definiuje eksporty, gdy istnieje.
- **Importy:** `import a.b`, `from a.b import c`, względne `from . import x`; alternatywy `try/except ImportError` obie
  zapisane; dynamiczny `importlib` nierozwiązany.
- **Wywołania:** wywołania zaimportowanych funkcji/klas i funkcji modułu, `self.method()` w klasie i jej bazowych klasach
  z projektu, `Class.method()`. Pozostałe wywołania atrybutów nierozwiązane — poziom „Imports (+ simple calls)” i UI to
  mówi. Type hints mogą to kiedyś poprawić.
- Fixture: pakiet w układzie `src/` z importami względnymi.
- CHANGELOG: „**Code Map:** Python support — packages, declarations, imports and simple calls.”

## Kryteria ukończenia (per wydanie języka)

### 11a Go — implemented 2026-10-20

- [x] Grammar already bundled and verified; no dependency/license change. Extractor, workspace/module resolver,
  vendor exclusion, support levels, build-tag metadata and explicit limitations implemented.
- [x] Reviewed fixture (calls 7/0/0 TP/FP/FN), deterministic extraction and packaged offline 10k benchmark recorded in
  [results/2026-10-20-go.md](results/2026-10-20-go.md). Memory target remains unmet.
- [x] Full checks and Go app E2E; broader Code Map/visualizer/host/startup E2E 16/16.

Java and Python remain to implement.

- [ ] Checklista języka spełniona; liczby w `results/<data>-<język>.md`.
- [ ] `npm run check` + E2E (`code-map.spec.ts` z fixture języka) zielone.

## Pułapki

- Krawędzie nie przekraczają rodzin języków.
- Nie uruchamiaj `go`, `mvn`, `gradle`, `pip` ani niczego podobnego — konfiguracja tylko jako dane.
