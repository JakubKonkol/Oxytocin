# Etap 01 — fundament: kontrakty, Code Map Host i katalog `.oxy`

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 8.1–8.3) i plik wyników etapu 00.

## Cel

Położyć fundament bez żadnych zmian widocznych dla użytkownika: wspólne kontrakty, nowy nadzorowany proces Code Map
Host oraz cały kod obsługi katalogu `.oxy/` (tworzenie, `.gitignore`, atomowy zapis, lock właściciela).

## Wymagania wejściowe

- Etap 00 zrobiony: decyzja o runtime parsera i układzie pakowania gramatyk.

## Zakres

W zakresie: FR-DIR-1…9 (logika, bez UI), FR-UPD-1 (proces i priorytet), FR-ST-4 (status hosta), NFR-8 (atomowość).

Poza zakresem: enumeracja i watcher (etap 02), parsowanie (etap 03), UI i IPC (etap 04).

## Zadania

### 1.1 Wspólne kontrakty (commit wewnętrzny)

- `src/shared/domain/code-map.ts` (nowy):
  - `CodeMapSettingsSchema`: `enabled`, `excludedPaths`, `ignoreInGit` (brak = `true`); pole `memory` dochodzi dopiero
    w etapie 12 (nie dodawaj go teraz);
  - `CodeMapStateSchema`: `disabled | indexing | ready | updating | paused | degraded | error | limit`;
  - `CodeMapStatusSchema`: stan, postęp, liczby, pokrycie per język i poziom wsparcia, ostatnia aktualizacja, rozmiar,
    błąd, właściciel (`owner.lock`);
  - `CodeMapGraphSchema` i `CodeMapManifestSchema` — dokładnie formaty z sekcji 8.3 `README.md`;
  - schemat diagnostyki (pominięte/nieudane pliki, nierozwiązane importy — listy ograniczone).
- `src/shared/domain/project.ts`: `ProjectSettingsSchema.codeMap` opcjonalne (brak = wyłączone).
- `src/shared/rpc/contracts/code-map-host.ts` (nowy): metody `checkout:configure` (root, tryb `project`/`worktree`,
  wykluczenia, `ignoreInGit`, ścieżka gita), `checkout:remove`, `checkout:rebuild`, `checkout:pause`, `checkout:resume`,
  `checkout:deleteData`, `checkout:status`, `checkout:diagnostics`; zdarzenie `checkout:status` (kompaktowe, maks. 4/s).
  Metody zapytań dojdą w etapie 06.
- Testy: domyślne wartości schematów; stary `projects.json` bez `codeMap` ładuje się; round-trip fixture grafu i
  manifestu przez schematy.

### 1.2 Szkielet Code Map Host (commit wewnętrzny)

- `src/code-map-host/index.ts`: bootstrap jak w pozostałych hostach (port RPC, health ping, logowanie).
- `src/main/hosts/hosts.ts`: wpis `codeMapHost` (unia `HostEntry`), nazwa `Oxytocin Code Map Host`, prefiks logów np.
  `map`, port inspect **9235**. Start leniwy (wzorzec: Connections Host — „Starts the Connections Host when it is not
  running”), zatrzymanie, gdy nie ma już skonfigurowanych checkoutów.
- `src/main/app/paths.ts` (unia `hostEntry`), `electron.vite.config.ts` (wejście `codeMapHost`), `eslint.config.mjs`
  (granice importów: host importuje tylko `@shared`), `tsconfig.node.json` (include), kopiowanie zasobów WASM (układ z
  etapu 00), `electron-builder.yml` (`resources/code-map/...` lub `asarUnpack` wg spike'u).
- Po starcie hosta main obniża mu priorytet: `os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)`; błąd
  obniżenia jest logowany, nie zatrzymuje hosta.
- Status hosta (zdrowie, restarty) widoczny w istniejącym statusie hostów (FR-ST-4).
- Testy: nadzór w stylu istniejących testów `UtilityHost` (restart, health), test wywołania `setPriority` na uchwycie
  procesu, test pakowania w `scripts/packaging.test.ts`, że bundle hosta i gramatyki są w paczce.

### 1.3 Katalog `.oxy`, `.gitignore`, zapis (commit wewnętrzny)

- `src/code-map-host/store/oxy-dir.ts`: tworzenie `.oxy/`, `.oxy/.gitignore` (wariant `*` albo lista plików lokalnych —
  sekcja 8.3), `.oxy/README.md` (tekst z sekcji 8.3), `code-map/`; zawieranie (realne ścieżki, odmowa symlinków
  wychodzących poza projekt); `owner.lock` z heartbeatem co 30 s i przejęciem po 2 min albo po martwym procesie.
- `src/code-map-host/store/gitignore.ts` — czyste funkcje:
  - `ensureOxyIgnored(text: string): string | null` — `null`, gdy wpis już jest (`.oxy`, `.oxy/`, `/.oxy`, `/.oxy/` po
    obcięciu białych znaków); w przeciwnym razie tekst z dopisanym `# Oxytocin local data (Code Map)` + `/.oxy/` z
    zachowaniem EOL (CRLF/LF), BOM i znaku nowej linii na końcu;
  - `removeOxyEntry(text: string): string | null` — usuwa wyłącznie dokładnie ten niezmieniony, sąsiedni blok dwóch linii,
    który dodał Oxytocin; `null`, gdy go nie ma albo został zmieniony;
  - aktualizacja pliku z zabezpieczeniami: odmowa dla symlinku, pliku poza projektem po rozwiązaniu realnych ścieżek,
    pliku niezapisywalnego (stan błędu, mapa zostaje włączona); pominięcie dla worktree (tryb `worktree`) i folderów bez
    Gita (`git rev-parse --is-inside-work-tree`); projekt w podfolderze repozytorium → `.gitignore` w folderze projektu.
- `src/code-map-host/store/writer.ts`: atomowy zapis temp + rename z ponawianiem na Windows (`EPERM`/`EBUSY`, backoff do
  2 s), kolejność publikacji cache → `graph.json` → `MAP.md` → `manifest.json`, walidacja hasha grafu względem manifestu
  przy starcie, sprzątanie `*.tmp-*` starszych niż godzina, przycinanie cache, liczenie rozmiaru.
- `src/workspace-host/git/repo-watcher.ts`: zawsze ignoruj `.oxy` w katalogu głównym obserwowanego drzewa (dopisz do
  wzorców `rootIgnore`, obok `ignorePatterns(this.o.ignoredFolders)`), niezależnie od edytowalnego `git.ignoredFolders`.
  Uwaga: istniejąca stała `ALWAYS_IGNORED_IN_GIT` dotyczy podkatalogów `.git` — nie mieszaj tych list.

## Testy

Unit (`unit-node`):

- `.gitignore`: brak pliku; CRLF; BOM; brak końcowego znaku nowej linii; każdy wariant istniejącego wpisu; symlink;
  projekt w podfolderze; opcja wyłączona; wyłączenie usuwa tylko niezmieniony blok; zmieniony blok zostaje z komunikatem;
  ponowne włączenie.
- `owner.lock`: przejęcie po nieaktualnym heartbeacie i po nieistniejącym procesie; brak przejęcia żywego locka.
- Zapis: przerwanie publikacji (zabicie między zapisami — symulowane) zostawia czytelny ostatni dobry graf; niezgodny hash
  manifestu wymusza przebudowę; sprzątanie plików tymczasowych.
- `repo-watcher`: zapis w `.oxy/` nie emituje odświeżenia `fs` (FR-DIR-6).
- Malformed payload na nowej granicy RPC jest odrzucany.

## Kryteria ukończenia

- [ ] `npm run check` zielone; aplikacja się buduje i startuje (host nie startuje, bo nikt nie włączył Code Map).
- [ ] Test pakowania potwierdza bundle hosta i gramatyki w paczce.
- [ ] Wszystkie przypadki `.gitignore` z macierzy w sekcji „Testy” pokryte.
- [ ] Brak zmian widocznych dla użytkownika.

## Commity i CHANGELOG

- `feat(code-map): add the shared Code Map contracts`
- `feat(code-map): add the Code Map utility host`
- `feat(code-map): write the .oxy folder and keep it out of Git`
- Bez wpisu w CHANGELOG (commity wewnętrzne, nic widocznego).

## Pułapki

- `src/shared` nie może importować electron, DOM ani API tylko dla Node.
- TS 6: ustaw `types` jawnie w każdym nowym tsconfig (jeśli dodajesz).
- Zawsze `git --no-optional-locks` (inaczej `index.lock` koliduje z agentem).
- Nie zapisuj nigdy niczego poza `.oxy/` poza wpisem w `.gitignore` (FR-DIR-4).
