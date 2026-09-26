# 06 — Domena 2: Podgląd zmian i integracja z Git

Wymagania: **R-GIT-1** (watcher w czasie rzeczywistym), **R-GIT-2** (diff względem HEAD), **R-GIT-3** (drzewo ze statusami), **R-GIT-4** (opcjonalnie Discard/Commit).

Cel panelu: **bezpieczeństwo i weryfikacja pracy agentów** — w każdej chwili widać, czym stan plików różni się od ostatniego commita, i można to obejrzeć jednym kliknięciem.

## 1. Architektura

```
Workspace Host (utilityProcess)
 ├─ RepoRegistry: projectId → RepoWatcher
 │    ├─ discover(): toplevel, gitDir, commonDir, isBare, hasHead
 │    ├─ @parcel/watcher.subscribe(worktreeRoot, ignore[])      ── zdarzenia plików
 │    ├─ @parcel/watcher.subscribe(gitDir) (jeśli poza worktree) ── HEAD/index/refs
 │    └─ RefreshScheduler (debounce + single-flight + adaptacja)
 │          └─ computeStatus(): git status v2 + git diff --numstat + liczenie linii untracked
 └─ getFileDiff(path): HEAD blob (cat-file --filters) + plik z dysku
        │ RPC events 'git:status', 'git:fileTouched'
        ▼
Main: GitService (cache ostatniego statusu per projekt, start/stop watcherów wg aktywności projektów)
        │ IPC events
        ▼
Renderer: changes store (Zustand) → ChangesSection (drzewo) · DiffPanel (Monaco)
```

## 2. Wymagania wstępne i wykrywanie repozytorium

- Git: ustawienie `git.path` lub `git` z PATH; przy starcie Workspace Host `git --version` (wymagane ≥ 2.30; ostrzeżenie przy starszym). Brak → `GIT_NOT_FOUND` i karta w UI.
- Każde wywołanie git: `spawn(git, ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })`.
  **`--no-optional-locks` jest krytyczne:** bez niego `git status` odświeża indeks i zakłada `index.lock`, co może zablokować równoległe operacje git wykonywane przez agenta („fatal: Unable to create index.lock”).
- Wykrycie (`discover.ts`): `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir --is-bare-repository` w `project.rootPath`, oraz `git rev-parse --verify -q HEAD` (brak HEAD = repo bez commitów).
  - Nie repo → stan `not-a-repo` (UI: „Not a git repository” + w M8 przycisk „Initialize repository”).
  - Projekt w podkatalogu repo (monorepo) → `toplevel ≠ rootPath`: status liczony dla całego repo z **pathspec** `-- <rootPath względny>`; ścieżki w UI względne do `rootPath` projektu, z przełącznikiem „Show changes from the whole repository”.
  - Worktree (`.git` jest plikiem) → `gitDir` poza drzewem roboczym, obserwowany osobno.
- Wszystkie wywołania mają timeout (status 30 s, diff 10 s, show 10 s) i limit wyjścia (status: 50 MB).

## 3. Watcher i harmonogram odświeżania (R-GIT-1)

### 3.1 Subskrypcje

- **Drzewo robocze:** `@parcel/watcher.subscribe(toplevelOrRoot, cb, { ignore })`, gdzie `ignore` = `['.git/objects', '.git/logs', '.git/lfs', ...settings.git.ignoredFolders]`; domyślne `git.ignoredFolders`: `node_modules`, `.next`, `.nuxt`, `.turbo`, `.cache`, `dist`, `build`, `out`, `target`, `.venv`, `venv`, `__pycache__`, `.gradle`, `.idea`, `.vs`, `coverage`.
  (Ignorowanie oszczędza CPU podczas burz zdarzeń, np. `npm install`. Jeśli ignorowany katalog jest śledzony w git, jego zmiany i tak wyjdą przy następnym odświeżeniu wywołanym czymkolwiek innym oraz przy odświeżeniu okresowym — §3.3.)
- **Katalog git:** zmiany w `HEAD`, `index`, `refs/**`, `packed-refs`, `MERGE_HEAD`, `REBASE_*` → odświeżenie (commit, checkout, stage wykonane przez agenta lub użytkownika w terminalu). Pozostałe zdarzenia z `.git/` ignorowane.
- **Spike S4 (M0):** `@parcel/watcher` w utilityProcess na Windows: repo z `node_modules` (≥ 50k plików) + `npm install` — zmierzyć liczbę zdarzeń, CPU, czas do ciszy; sprawdzić zachowanie na dyskach sieciowych i ścieżkach > 260 znaków.

### 3.2 `RefreshScheduler`

```ts
class RefreshScheduler {
  // debounce trailing 250 ms, maxWait 1000 ms (pod ciągłym strumieniem zdarzeń odświeżamy co ≤ 1 s)
  // single-flight: gdy obliczenie trwa, kolejne żądania ustawiają flagę dirty → jedno kolejne obliczenie po zakończeniu
  // adaptacja: jeśli ostatnie obliczenie trwało T > 500 ms, debounce = min(5000, 2T)
  // priorytet: projekt aktywny > pozostałe (kolejka z jednym workerem na wszystkie repo)
  request(reason: 'fs' | 'gitdir' | 'manual' | 'focus' | 'periodic'): void;
}
```

- Równolegle z debouncem emitujemy **`git:fileTouched`** (ścieżki z ostatnich zdarzeń FS, throttle 200 ms) — UI natychmiast podświetla „na żywo” pliki, które agent właśnie zapisuje, zanim przyjdzie pełny status.

### 3.3 Odświeżanie dodatkowe

- Fokus okna → `request('focus')` dla aktywnego projektu.
- Okresowo co 15 s dla aktywnego projektu, gdy okno ma fokus (siatka bezpieczeństwa dla zgubionych zdarzeń / dysków sieciowych).
- Ręcznie: przycisk ⟳ i polecenie „Git: Refresh”.

## 4. Obliczanie statusu (R-GIT-2, R-GIT-3)

### 4.1 Polecenia

1. `git status --porcelain=v2 -z --branch --untracked-files=all --find-renames [-- <pathspec>]`
2. `git diff HEAD --numstat -z --find-renames [-- <pathspec>]` (brak HEAD → `git diff --cached --numstat -z 4b825dc642cb6eb9a060e54bf8d69288fbee4904` względem pustego drzewa dla plików w indeksie)
3. Dla plików nieśledzonych: liczba linii liczona w Workspace Host (odczyt pliku ≤ 1 MB, wykrycie binarności: bajt `\0` w pierwszych 8 KB; maks. 2000 plików na odświeżenie — powyżej liczniki `?`).

### 4.2 Parser porcelain v2 (`porcelain-v2.ts`)

Format (z `-z` rekordy kończy NUL; w rekordzie typu `2` ścieżka oryginalna jest **kolejnym** polem NUL):
```
# branch.oid <commit> | (initial)
# branch.head <branch> | (detached)
# branch.upstream <upstream>
# branch.ab +<ahead> -<behind>
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
? <path>
! <path>            (nie występuje bez --ignored)
```
`X` = indeks vs HEAD, `Y` = drzewo robocze vs indeks, `.` = bez zmian. `<sub>` = `N...` lub `S<c><m><u>` (submoduł).

### 4.3 Wyprowadzenie statusu „względem HEAD”

```ts
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange';

function statusVsHead(rec: PorcelainRecord): ChangeStatus | null {
  if (rec.type === 'u') return 'conflicted';
  if (rec.type === '?') return 'untracked';
  const [X, Y] = rec.xy;
  if (X === 'A' && Y === 'D') return null;               // dodany do indeksu i usunięty z dysku → brak różnicy vs HEAD
  if (rec.type === '2') return 'renamed';                 // rename/copy w indeksie (origPath dostępny)
  if (X === 'A') return 'added';
  if (X === 'D' || Y === 'D') return 'deleted';
  if (X === 'T' || Y === 'T') return 'typechange';
  if (X === 'M' || Y === 'M' || X === 'R' || X === 'C') return 'modified';
  return null;
}
```
- Rename niezastage'owany (agent zrobił `mv` bez `git mv`) pojawia się jako `deleted` + `untracked` — tak samo jak w VS Code; akceptujemy. (Opcjonalnie M8: parowanie przez `git diff HEAD -M --name-status` po `git add -N` — nie w MVP, bo modyfikuje indeks.)
- Submoduły: status `modified` z ikoną submodułu; bez rozwijania zawartości.
- Pliki ignorowane — nie pokazujemy.

### 4.4 Model wynikowy

```ts
// src/shared/domain/git.ts
export interface FileChange {
  path: string;                 // względna do rootPath projektu (separator '/')
  oldPath?: string;             // dla renamed
  status: ChangeStatus;
  staged: boolean;              // X !== '.'
  unstaged: boolean;            // Y !== '.' lub untracked
  additions?: number;           // z numstat / liczenia linii
  deletions?: number;
  binary?: boolean;             // numstat "-\t-"
  submodule?: boolean;
  touchedAt?: number;           // ostatnie zdarzenie FS dla ścieżki (dla podświetlenia „na żywo”)
}

export interface RepoStatus {
  projectId: ProjectId;
  state: 'ok' | 'not-a-repo' | 'git-missing' | 'error';
  error?: string;
  toplevel?: string;
  branch?: { head: string | null; detached: boolean; oid?: string; upstream?: string; ahead: number; behind: number };
  headCommit?: { oid: string; subject: string; date: number };   // git log -1 --format=%H%x00%s%x00%ct (tylko gdy oid się zmienił)
  hasHead: boolean;
  files: FileChange[];
  totals: { files: number; additions: number; deletions: number };
  truncated?: { shown: number; total: number };
  computedAt: number;
  durationMs: number;
}
```
- Limit `git.maxFiles` (domyślnie 5000) — powyżej lista obcięta (sortowana: najnowsze `touchedAt` najpierw), baner „Showing 5,000 of 23,118 changes — consider updating .gitignore”.
- Emisja `git:status` tylko przy zmianie (porównanie hash wyniku), aby nie przerysowywać drzewa bez potrzeby.

## 5. Treść do diffu (R-GIT-2)

`getFileDiff({ projectId, path, oldPath? })` w Workspace Host:
```ts
export interface FileDiffContent {
  path: string; oldPath?: string; status: ChangeStatus;
  original: string | null;            // wersja z HEAD (null dla added/untracked lub braku HEAD)
  modified: string | null;            // wersja z dysku (null dla deleted)
  languageId: string;                 // z rozszerzenia (mapa → id języków Monaco)
  binary?: boolean;
  tooLarge?: { sizeBytes: number };   // > git.diff.maxFileSizeMb (domyślnie 2 MB) → bez treści
  eol?: 'crlf' | 'lf' | 'mixed';
}
```
- **Wersja z HEAD:** `git cat-file --filters HEAD:<pathFromToplevel>` — stosuje filtry checkoutu (autocrlf/eol/`.gitattributes`, smudge), więc wynik odpowiada temu, jak plik wyglądałby na dysku. Bez tego na Windows z `core.autocrlf=true` każda linia pokazywałaby się jako zmieniona (LF z repo vs CRLF na dysku). Dla renamed → `HEAD:<oldPath>`.
- **Wersja z dysku:** `fs.readFile` (ścieżka zweryfikowana jako wewnątrz toplevel), dekodowanie UTF-8 (BOM usuwany i raportowany); wykrycie binarności jak wyżej.
- LFS: jeśli wersja z HEAD jest pointerem LFS (`version https://git-lfs.github.com/spec/v1`) — `--filters` uruchomi smudge, jeśli LFS zainstalowane; w przeciwnym razie pokaż pointer + informację.
- Pliki > limit: panel z informacją i przyciskiem „Open in editor”.

## 6. Panel Zmian — UI (sidebar, sekcja środkowa)

### 6.1 Nagłówek

```
CHANGES  ⎇ feature/refactor ↑2 ↓0                    ⟳  ⋯
███████████████████████░░░░░   +142 −28 · 7 files
```
- `SplitBar`: szerokość zielona = additions / (additions + deletions); przy 0/0 — pusty pasek.
- Tooltip gałęzi: upstream, ahead/behind, ostatni commit (skrót SHA, temat, data).
- Menu ⋯: Tree/list view · Collapse all · Show changes from the whole repository (monorepo) · Refresh · (M8) Discard all… · (M8) Commit all…

### 6.2 Drzewo

- Budowa (`tree-model.ts`): z płaskiej listy ścieżek → drzewo katalogów; **kompaktowanie** łańcuchów pojedynczych katalogów (`src/features/terminals` jako jeden węzeł, jak „compact folders” w VS Code); sortowanie: katalogi przed plikami, alfabetycznie (lub opcja „Recently changed first”).
- Wiersz pliku (24 px): ikona typu pliku · nazwa · (w trybie listy: szary katalog) · po prawej `+12 −3` (małe, zielone/czerwone) i **litera statusu** kolorem: `A` (added, `--git-added`), `M` (`--git-modified`), `D` (`--git-deleted`, nazwa przekreślona), `R` (`--git-renamed`, tooltip „from: old/path”), `U` (untracked, `--git-untracked`), `C` (konflikt, `--git-conflict`), `T` (typechange).
- Wiersz katalogu: strzałka, nazwa, liczba zmienionych plików w poddrzewie, zagregowany kolor (najpoważniejszy status wg kolejności C > D > M > A/U).
- **„Na żywo”**: plik z `touchedAt` < 5 s → ikona ⚡ / pulsująca kropka `--accent` + jednorazowy pulse tła; katalog zawierający taki plik — mała kropka.
- Wirtualizacja (`@tanstack/react-virtual`) — płynnie przy 5000 wierszach.
- Klawiatura: ↑/↓ nawigacja, ←/→ zwiń/rozwiń, Enter = otwórz diff (preview), Ctrl+Enter = otwórz w edytorze, Space = podgląd (preview bez przenoszenia fokusu), `/` = filtr.
- Mysz: klik = diff w trybie preview; dwuklik = diff przypięty; przeciągnięcie na terminal = wklejenie ścieżki; przeciągnięcie na obszar centralny = diff w tym miejscu.
- Menu kontekstowe pliku: Open diff · Open diff in new group · Open in editor · Open preview (jeśli wtyczka ma opener dla rozszerzenia, np. `.md`) · Reveal in Explorer · Copy path / Copy relative path · (M8) Discard changes… · (M8) Stage/Unstage.
- Stany puste: „No changes since HEAD ✓” (z datą ostatniego commita), „Not a git repository”, „Git not found”, „No commits yet — all files are new”.

### 6.3 Stan per projekt

Rozwinięte węzły, tryb, filtr, zaznaczenie → `WorkspaceState.ui.changes` ([03 §7](03-projects-workspace.md)). Domyślnie rozwinięte wszystkie katalogi, jeśli plików ≤ 50.

## 7. Panel diffu (obszar centralny)

- Monaco `DiffEditor` przez `@monaco-editor/react` skonfigurowany na **lokalny** bundle: `loader.config({ monaco })` z `import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'` + `import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'` (kolorowanie Monarch dla ~80 języków) — **bez** workerów językowych TS/JSON/CSS/HTML (niepotrzebne w trybie read-only).
- Worker: tylko `editor.worker` (liczy diff): `self.MonacoEnvironment = { getWorker: () => new EditorWorker() }` z `import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'`. **Spike S8 (M4):** worker i fonty codicon działają pod `app://` w buildzie produkcyjnym przy naszej CSP.
- Opcje:
  ```ts
  {
    readOnly: true, originalEditable: false, domReadOnly: true,
    renderSideBySide: settings.git.diff.sideBySide,          // domyślnie true
    useInlineViewWhenSpaceIsLimited: true,                    // wąski panel → inline
    renderSideBySideInlineBreakpoint: 900,
    ignoreTrimWhitespace: settings.git.diff.ignoreWhitespace, // domyślnie false
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
    renderOverviewRuler: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
    fontFamily: 'var(--font-mono)', fontSize: 13, automaticLayout: false,   // layout ręcznie przez ResizeObserver (ukryte panele)
    diffAlgorithm: 'advanced',
  }
  ```
- Pasek narzędzi panelu: ścieżka (breadcrumb), status, `+a −d`, przełączniki: side-by-side/inline, ignoruj białe znaki, zwiń niezmienione; nawigacja „Next/previous change” (F7 / Shift+F7); „Open in editor” (skacze do linii bieżącej zmiany); (M8) „Discard file changes”.
- **Aktualizacja na żywo:** gdy `git:status`/`git:fileTouched` dotyczy otwartej ścieżki → ponowne pobranie treści (debounce 300 ms) → `modifiedModel.setValue()` z zachowaniem `viewState` (scroll, zwinięcia). Wskaźnik „updated 2s ago”.
- Stany specjalne: plik usunięty (tylko lewa strona, baner „File deleted”), nowy (tylko prawa), binarny („Binary file — diff not available”, rozmiary przed/po), za duży, błąd odczytu.
- Motyw Monaco `oxytocin-dark` definiowany z tokenów (`monaco.editor.defineTheme`), w tym kolory `diffEditor.insertedTextBackground`, `diffEditor.removedTextBackground`, `diffEditor.insertedLineBackground`, `diffEditor.removedLineBackground`.

## 8. Akcje (R-GIT-4, M8)

Wszystkie w Workspace Host (git) + main (kosz, dialogi). Każda destrukcyjna akcja wymaga `ConfirmDialog` z listą plików; po wykonaniu wymuszone odświeżenie.

| Akcja | Polecenie | Uwagi bezpieczeństwa |
|---|---|---|
| Odrzuć zmiany pliku śledzonego | `git restore --source=HEAD --staged --worktree -- <path>` | Przed wykonaniem kopia bieżącej wersji do `userData/discard-backup/<projectId>/<ts>/<path>` (retencja 7 dni) + toast „Undo” (przywraca z kopii). |
| Odrzuć plik nieśledzony | `shell.trashItem(absPath)` (main) | Do Kosza systemowego, nie `rm`. |
| Odrzuć rename | restore `oldPath` + kosz dla nowej ścieżki | |
| Odrzuć wszystko | iteracja powyższych (w projekcie / pathspec) | Dialog z liczbą plików; wpisanie potwierdzenia nie jest wymagane, ale domyślny fokus na „Cancel”. |
| Stage / Unstage pliku | `git add -- <path>` / `git restore --staged -- <path>` | Pokazujemy znacznik „staged” w wierszu. |
| Commit | dialog z wiadomością (wielolinijkowy; pierwsza linia ≤ 72 znaki — licznik) + opcja „Commit all changes (git add -A)” / „Staged only” → `git commit -F <tmpfile>` | Hooki git działają normalnie; błąd hooka → panel z pełnym wyjściem stderr. Nie wspieramy `--amend`, `--no-verify` w M8. |
| Inicjuj repozytorium | `git init` | Tylko gdy `not-a-repo`. |

**Tryb „Review” (M8):** panel centralny z wszystkimi diffami jeden pod drugim (wirtualizowana lista zwiniętych/rozwijanych plików, unified diff renderowany lekko — np. własny komponent na wyjściu `git diff HEAD -U3` z podświetlaniem shiki), klawisze `j/k` między plikami, „Mark as reviewed” (stan lokalny per ścieżka+hash zawartości).

**Checkpointy (backlog v0.3):** migawka stanu roboczego bez naruszania indeksu użytkownika: `GIT_INDEX_FILE=<tmp> git add -A && git write-tree && git commit-tree <tree> -p HEAD -m "oxytocin checkpoint"` → `git update-ref refs/oxytocin/checkpoints/<ts> <sha>`; przywrócenie przez `git restore --source=<sha> --worktree -- .` + usunięcie nowych plików. Automatycznie przed startem agenta (opcja).

## 9. Wydajność

| Scenariusz | Budżet |
|---|---|
| Zapis pliku przez agenta → podświetlenie „na żywo” w drzewie | < 300 ms |
| Zapis pliku → zaktualizowany status i liczniki | < 1 s (repo 10k plików) |
| `npm install` (burza zdarzeń) | UI płynne; status aktualizowany ≤ 1×/s; CPU Workspace Host < 1 rdzeń średnio |
| Otwarcie diffu pliku 2000 linii | < 300 ms do pierwszego renderu |
| Repo 100k plików | status < 2 s; wskazówka w UI: `git config core.fsmonitor true` i `core.untrackedCache true` (tylko sugestia — nie zmieniamy konfiguracji repo) |

## 10. Testy

- **Unit:** parser porcelain v2 (wszystkie typy rekordów, `-z`, spacje i znaki Unicode w nazwach, rename z origPath, submoduł, `(initial)`, `(detached)`), parser numstat (`-\t-` binarne, renames `{a => b}` przy `-z` jako osobne pola), `statusVsHead` (tabela przypadków XY), budowa i kompaktowanie drzewa, harmonogram (fake timers: debounce, maxWait, single-flight, adaptacja).
- **Integration (prawdziwy git w katalogach tymczasowych):** repo bez commitów; dodanie/modyfikacja/usunięcie/rename (`git mv` i zwykły `mv`); pliki z CRLF przy `core.autocrlf=true` → diff bez fałszywych zmian; plik binarny; projekt jako podkatalog repo (pathspec); worktree; równoległy `git commit` w trakcie odświeżania (brak `index.lock` konfliktów dzięki `--no-optional-locks`).
- **E2E:** utworzenie pliku w terminalu (`echo x > a.txt`) → pojawia się `U a.txt` < 1 s; modyfikacja śledzonego → `M` + liczniki; klik → diff z poprawną treścią; `git commit -am` w terminalu → lista pusta.

## 11. Kryteria akceptacji (M4)

- [ ] Drzewo zmian aktualizuje się samo w < 1 s po zapisie pliku przez proces w terminalu; wskaźnik „na żywo” pojawia się w < 300 ms.
- [ ] Statusy A/M/D/R/U poprawne względem HEAD (w tym staged + unstaged łącznie); sumy +/− zgodne z `git diff HEAD --shortstat` + linie untracked.
- [ ] Diff side-by-side i inline, zwijanie niezmienionych regionów, brak fałszywych różnic CRLF.
- [ ] Brak konfliktów `index.lock` przy agencie wykonującym operacje git w pętli (test integracyjny 100 commitów podczas ciągłego odświeżania).
- [ ] Stany: nie-repo, brak git, repo bez commitów, > 5000 zmian (obcięcie + baner).
- [ ] (M8) Discard z kopią zapasową i „Undo”; untracked do Kosza; Commit z dialogu z obsługą błędów hooków.
