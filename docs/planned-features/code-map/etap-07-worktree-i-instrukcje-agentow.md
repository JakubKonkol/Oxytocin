# Etap 07 — mapy worktree i blok instrukcji dla agentów

> Część planu [Code Map](README.md). Przeczytaj `README.md` (sekcje 5.2 FR-DIR-3, 5.5 FR-AG-4/7, 5.8, 8.3, 8.7).

## Cel

Worktree Ensemble projektu z Code Map mają własne mapy, a agenci Ensemble pytają wyłącznie swoją. Użytkownik może jednym
kliknięciem wstawić instrukcję Code Map do `CLAUDE.md` albo `AGENTS.md`. Wydanie samodzielne.

## Wymagania wejściowe

- Etap 06 wydany (narzędzia MCP i ścisły wybór checkoutu).

## Zakres

W zakresie: FR-WT-1, FR-WT-2, FR-AG-4 (worktree), FR-AG-7, FR-DIR-3 (worktree).

Poza zakresem: selektor checkoutu w wizualizatorze (etap 10).

## Zadania

### 7.1 Worktree

- `src/main/services/ensemble/ensemble-service.ts`: gdy worktree jest gotowy (zdarzenie `workspace-ready`) i projekt ma
  włączone Code Map, skonfiguruj checkout w trybie `worktree` (bez edycji `.gitignore` w katalogu głównym; `.oxy/.gitignore`
  zawsze `*`, niezależnie od opcji Gita); usuń go przy usuwaniu worktree. Worktree powstają domyślnie poza repozytorium
  (`<repo>.worktrees/<slug>-<id>` albo `ensemble.worktreeRoot`); projekt w podfolderze repozytorium mapuje się na ten sam
  podfolder worktree.
- Most MCP Ensemble (`ensembleBridgeTools` w `src/main/services/mcp/mcp-hub.ts`, `src/main/services/ensemble/ensemble-tools.ts`): lista dozwolonych
  narzędzi Code Map tylko do odczytu; checkout wynika z uwierzytelnionej roli/worktree, nigdy z selektorów podanych przez
  wołającego ani z nagłówka terminala. Odwołanie roli/usunięcie worktree anuluje dostęp i oczekujące żądania.
- Dla worktree nigdy nie jest zwracana mapa głównego projektu (FR-WT-2).

### 7.2 Blok instrukcji

- Zakładka Code Map: **Add to CLAUDE.md** / **Add to AGENTS.md** / **Remove**. Wstawia tekst instrukcji (sekcja 8.7, wersja
  z narzędziami) między `<!-- oxytocin:code-map:start -->` i `<!-- oxytocin:code-map:end -->`; idempotentnie; zachowuje
  EOL; odmawia dla symlinków wychodzących poza katalog główny; tylko na jawne kliknięcie (nigdy automatycznie).
- Czysta funkcja wstawiania/usuwania bloku w `src/shared/` (bez I/O), zapis przez Code Map Host z kontrolą zawierania.

## Testy

- Dwa projekty + dwa rozbieżne worktree: rola nie może zapytać sąsiedniego checkoutu; usunięty worktree → odmowa.
- Unit funkcji bloku: wstawienie, ponowne wstawienie (bez duplikatu), usunięcie przywraca plik, CRLF, brak pliku,
  zmieniony blok.
- Rozszerzenie `tests/e2e/ensemble*.spec.ts`: sprawdzenie mapy worktree (`.oxy/code-map/graph.json` w worktree, brak zmian
  map w diffie agenta).
- E2E: klik **Add to CLAUDE.md** → plik zawiera jeden blok → **Remove** → plik przywrócony.

## Kryteria ukończenia

- [x] Ensemble pyta o swój uwierzytelniony checkout; brak fallbacku między worktree.
- [x] Worktree nie dostają edycji `.gitignore`; diffy agentów nie zawierają plików mapy.
- [x] Blok instrukcji wstawiany/usuwany wyłącznie na żądanie.
- [x] `npm run check` + E2E (code-map, ensemble) zielone (Linux/Xvfb, weryfikacja po etapie 09; Windows do
      potwierdzenia).

## Commity i CHANGELOG

- `feat(code-map): map Ensemble worktrees separately`
- `feat(code-map): add the agent instructions to CLAUDE.md or AGENTS.md`

CHANGELOG (`### Added`):

> **Code Map:** Ensemble worktrees get their own maps, and agents in a worktree query only theirs. Add the Code Map
> instructions to `CLAUDE.md` or `AGENTS.md` with one click, and remove them the same way.

## Pułapki

- Edycja `.gitignore` w worktree pojawiłaby się jako zmiana agenta — w trybie `worktree` jest wyłączona bez wyjątków.
- Selektor z wywołania nie może przekierować roli Ensemble do innego checkoutu.

## Implementation notes (2026-10-20)

The core normal endpoint resolves registered worktree paths and terminal cwd; the Ensemble endpoint uses the role's
server-selected checkout and discards selectors. Registration is restored after restart and after a failed finish.
Instruction blocks include a comment recording the original EOF/missing-file convention so removal can restore exact
bytes; edited blocks are refused. Symlinks are conservatively refused even if they remain inside the project.
Ensemble Git pathspecs exclude `.oxy` in diffs and checkpoint commits, including already tracked/staged map artifacts.
See `results/2026-10-20-worktrees-instructions.md` for validation and the user-authorized app E2E exception.
