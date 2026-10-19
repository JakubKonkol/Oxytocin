# Etap 05 — C# (wydanie 1b)

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.3, 8.4, 8.8) i etap 03 (wzorzec ekstraktora).

## Cel

Pełne wsparcie C# (poziom **Calls**): projekty i solucje jako grupy, przestrzenie nazw, typy i członkowie, `using` i
referencje projektów, typy partial, wywołania rozwiązywane z zadeklarowanych typów. Osobne wydanie zaraz po 1a —
priorytet właściciela razem z TS/JS.

## Wymagania wejściowe

- Etap 04 wydany (1a). Gramatyka `tree-sitter-c-sharp` zweryfikowana w etapie 00.

## Zakres

W zakresie: FR-BLD-6, 7, 9, 13 (część C#), FR-BLD-14 (poziom C#).

Poza zakresem: Roslyn (wymaga toolchainu .NET), Razor/`.cshtml`/`.xaml` poza poziomem Files, metody rozszerzające,
`dynamic`, składnia zapytań LINQ, delegaty/zdarzenia, serwisy z DI (zostają nierozwiązane i liczone).

## Reguły C#

Rozszerzenia: `.cs`; pliki projektu `.csproj`, solucje `.sln`/`.slnx`, `Directory.Build.props` (tylko dane). `.razor`,
`.cshtml`, `.xaml` — poziom Files w v1.

- **Projekty jako grupy:** każdy `.csproj` to grupa projektu (nazwa, `RootNamespace`, `AssemblyName`,
  `TargetFramework(s)`, SDK, `ImplicitUsings`, `Nullable`). Pliki należą do najbliższego folderu projektu powyżej, minus
  globy `<Compile Remove>` (tylko proste globy; resztę raportuj). `ProjectReference` → krawędź projekt → projekt;
  `PackageReference` → węzeł pakietu zewnętrznego. Solucje dodają grupę solucji; projekty spoza solucji też działają.
- **Symbole:** przestrzenie nazw (blokowe i file-scoped), klasy, rekordy, struktury, interfejsy, enumy, delegaty, metody,
  konstruktory, właściwości, pola, zdarzenia, indeksery, operatory, funkcje lokalne; typy zagnieżdżone; generyki z
  arnością w ID (np. `Repository/1` dla `Repository<T>`); widoczność (`public`, `internal`, `protected`, `private`,
  `file`) zamiast „exported”.
- **Typy partial:** deklaracje o tym samym `namespace + name + arity` w różnych plikach scalają się w jeden symbol typu
  z kilkoma zakresami deklaracji; członkowie zostają w swoich plikach; krawędzie do typu wskazują scalony symbol.
- **Przeciążenia:** ID metody ma dyskryminator z liczby parametrów i tekstu zadeklarowanych typów parametrów
  (`Save(Order,bool)`), deterministyczny i niezależny od kolejności deklaracji.
- **Rozwiązywanie przestrzeni nazw** dla nazwy typu w pliku, w kolejności: typy zagnieżdżone/otaczające, bieżąca
  przestrzeń nazw i jej rodzice, dyrektywy `using` pliku, `global using` projektu, implicit usings SDK przy
  `ImplicitUsings` (stała, wersjonowana lista per rodzaj SDK, np. dla `Microsoft.NET.Sdk`: `System`, `System.IO`,
  `System.Linq`, `System.Net.Http`, `System.Threading`, `System.Threading.Tasks`, `System.Collections.Generic`),
  `using static`, `using Alias = …`. Typy widoczne przez `ProjectReference` są kandydatami; niejednoznaczności zostają
  nierozwiązane (nigdy zgadywane).
- **Referencje:** listy bazowe (`extends` dla pierwszej rozwiązanej klasy, `implements` dla rozwiązanych interfejsów —
  rozstrzyga rodzaj celu, nie prefiks `I`), typy zadeklarowane pól/właściwości/parametrów/zwracane/lokalne, argumenty
  generyczne, `new T()`, `typeof(T)`, `nameof(T)`, atrybuty, `catch (T)`, wzorce `is`/`as`.
- **Wywołania:** `M()` i `this.M()` w tym samym typie (i typach bazowych z projektu), `Type.M()` dla statycznych,
  `x.M()`, gdy `x` to parametr, pole, właściwość lub lokalna z zadeklarowanym typem albo `var x = new T(…)`, `base.M()`.
  Wybór przeciążenia tylko po liczbie argumentów; gdy pasuje kilka — krawędź do grupy metod z proweniencją `heuristic`.
- **Zależności plików:** C# nie ma importów plików. Krawędzie plik → plik `references` wyprowadzane z rozwiązanych
  referencji typów (plik A używa typu z pliku B); zasilają agregację Overview tak jak `imports` w TS.
- **Znane ograniczenia (opisane w UI):** source generatory i kod generowany do `obj/`, kompilacja warunkowa `#if` (obie
  gałęzie indeksowane i oznaczone), `InternalsVisibleTo`, różnice multi-targetingu, komponenty Razor.

## Zadania

1. `src/code-map-host/extract/csharp.ts` — deklaracje (przestrzenie nazw, typy, członkowie, dyskryminatory przeciążeń,
   arność generyków, widoczność), `using`/`global using`/`using static`/aliasy, listy bazowe, typy zadeklarowane,
   `new`/`typeof`/`nameof`/atrybuty, miejsca wywołań z wyrażeniem odbiorcy.
2. `src/code-map-host/resolve/dotnet-projects.ts` — `.csproj`/`.sln`/`.slnx`/`Directory.Build.props` jako XML/tekst
   (`RootNamespace`, `ImplicitUsings`, `TargetFramework(s)`, `ProjectReference`, `PackageReference`, proste
   `Compile Remove`); lista implicit usings per rodzaj SDK wersjonowana w kodzie.
3. `src/code-map-host/resolve/csharp.ts` — kolejność lookupu przestrzeni nazw, scalanie typów partial, wiązanie wywołań z
   zadeklarowanych typów, krawędzie `references` plik → plik; niejednoznaczność → nierozwiązane.
4. Domyślne wykluczenia `bin/`, `obj/`.
5. `MAP.md`: projekty i solucje jako sekcje układu; punkty wejścia z `OutputType=Exe`, `Program.cs`, ASP.NET
   `Program`/`Startup`.
6. UI: poziom „Calls” dla C# w pokryciu; krótki opis znanych ograniczeń.

## Testy

- Fixture `tests/fixtures/code-map/csharp-*`: solucja z dwoma projektami, `ProjectReference`, file-scoped namespaces,
  klasy partial, global i implicit usings, przeciążenia, generyki, metody rozszerzające (oczekiwane jako nierozwiązane),
  `#if`.
- Precision/recall, determinizm (przetasowanie, CRLF, warianty wielkości liter), wydajność na wygenerowanym fixture C#
  (dopisz generator do `scripts/make-fixtures.ts`), smoke spakowanego buildu ładujący gramatykę C# offline.
- E2E: rozszerzenie `tests/e2e/code-map.spec.ts` — projekt fixture C# pokazuje pokrycie „Calls” dla C# w zakładce, a jego
  typy są w `graph.json`.

## Kryteria ukończenia

- [ ] Fixture C# zielone, liczby precision/recall zapisane w `results/<data>-csharp.md`.
- [ ] Determinizm C# zielony na Windows i Linux.
- [ ] Gramatyka C# w `grammars.json` z hashem i licencją; noty licencyjne zaktualizowane.
- [ ] `npm run check` + E2E zielone.

## Commity i CHANGELOG

- `feat(code-map): index C# projects, types and calls`

CHANGELOG (`### Added`):

> **Code Map:** C# support — solutions and projects, namespaces, types and members, `using` directives and project
> references, and calls resolved from declared types.

## Pułapki

- Gramatyka C# ma 5,35 MB — ładuj ją leniwie, dopiero gdy projekt ma pliki `.cs` (decyzja z etapu 00).
- Nie rozstrzygaj interfejsu po prefiksie `I`.
- Nie zgaduj przeciążeń po typach argumentów, których nie znasz — tylko liczba argumentów.
