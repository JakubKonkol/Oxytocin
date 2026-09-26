# 09 — Persystencja i ustawienia

## 1. Układ katalogu `userData`

Windows: `%APPDATA%\Oxytocin\` · macOS: `~/Library/Application Support/Oxytocin/` · Linux: `~/.config/Oxytocin/`. Nadpisywane przez `--user-data-dir=<path>` lub `OXYTOCIN_USER_DATA_DIR` (testy E2E).

```
userData/
├─ settings.json                 # JSONC — ustawienia użytkownika (edytowalne ręcznie)
├─ keybindings.json              # JSONC — nadpisania skrótów (M7)
├─ projects.json                 # lista projektów + activeProjectId
├─ ui-state.json                 # okno (bounds, maximized), sidebar (szerokość, zwinięcie), Paneview (kolejność/rozmiary/ukryte), stany widoków sidebara wtyczek
├─ workspaces/
│  ├─ <projectId>.json           # WorkspaceState (układ dockview + deskryptory paneli)
│  └─ <projectId>/scrollback/<panelId>.vt   # snapshoty VT zapisane przy wyjściu (≤ 1 MB każdy)
├─ plugin-data/<pluginId>/       # storage wtyczek (globalDir), np. usage.db, pricing-cache.json, kv.json
├─ plugins/                      # wtyczki użytkownika (M9)
├─ discard-backup/<projectId>/<ts>/…   # kopie przed Discard (M8), retencja 7 dni
├─ logs/main.log (+ .1, .2)
└─ Crashpad/                     # lokalne zrzuty crashy (bez wysyłki)
```

Oxytocin **nie zapisuje niczego w katalogach projektów** użytkownika (zasada nieinwazyjności).

## 2. Zapis plików (`JsonStore`)

- `src/main/services/settings/jsonc-store.ts` (i wspólny `JsonFileStore` dla pozostałych plików):
  - odczyt → parsowanie (JSONC przez `jsonc-parser` dla `settings.json`/`keybindings.json`, zwykły JSON dla reszty) → migracje (§5) → walidacja zod;
  - zapis **atomowy**: `file.tmp` → `fsync` → `rename` na plik docelowy; na Windows `rename` może zwrócić `EPERM/EBUSY` (antywirus, indeksowanie) → 3 ponowienia z backoffem 50/150/400 ms;
  - po udanym zapisie kopia `file.bak` (dla `settings.json`, `projects.json`);
  - zapis debounce'owany (300 ms – 1 s zależnie od pliku) i serializowany (kolejka per plik); `flushAll()` przy wyjściu.
- Błąd parsowania przy odczycie → przeniesienie pliku do `file.corrupt-<ts>`, próba `file.bak`, w ostateczności wartości domyślne + toast z informacją i przyciskiem „Show file”.

## 3. Ustawienia

### 3.1 Zasady

- Jedno źródło: `settings.json` (JSONC, klucze płaskie z kropkami jak w VS Code, np. `"terminal.fontSize": 14`).
- Warstwy: **domyślne** (schemat rdzenia + schematy wtyczek) < **użytkownika** (`settings.json`) < **projektu** (tylko wybrane klucze w `Project.settings`, nie w pliku ustawień).
- Nieznane klucze są **zachowywane** (np. ustawienia wyłączonej wtyczki), a nie usuwane.
- Nieprawidłowa wartość → użycie domyślnej + wpis w „Settings problems” (toast z liczbą problemów, szczegóły w UI ustawień).
- Zapis z UI (M7) modyfikuje JSONC przez `jsonc-parser` (`modify` + `applyEdits`), zachowując komentarze i formatowanie.
- Zewnętrzna edycja pliku (np. w edytorze) → `fs.watch` → przeładowanie → `settings:changed`.
- Polecenie „Open settings.json” otwiera plik w edytorze użytkownika (`editor:open`).

### 3.2 Schemat ustawień rdzenia (domyślne)

| Klucz | Typ | Domyślnie | Opis |
|---|---|---|---|
| `appearance.theme` | `'dark' \| 'light' \| 'system'` | `'dark'` | Motyw (light od M7). |
| `appearance.uiZoom` | number 0.8–1.5 | `1` | Skala UI. |
| `appearance.reduceMotion` | boolean | `false` | Wyłącza animacje (także gdy OS prosi). |
| `terminal.defaultProfile.windows` / `.osx` / `.linux` | string \| null | `null` (auto) | Profil domyślny. |
| `terminal.profiles` | `TerminalProfile[]` | `[]` | Profile użytkownika. |
| `terminal.hiddenProfiles` | string[] | `[]` | Ukryte profile wykryte automatycznie. |
| `terminal.fontFamily` | string | `"Cascadia Mono, JetBrains Mono, Consolas, monospace"` (macOS: `"SF Mono, JetBrains Mono, Menlo, monospace"`) | |
| `terminal.fontSize` | number 8–32 | `13` | |
| `terminal.lineHeight` | number 1–2 | `1.2` | |
| `terminal.cursorStyle` | `'bar' \| 'block' \| 'underline'` | `'bar'` | |
| `terminal.cursorBlink` | boolean | `true` | |
| `terminal.scrollback` | number 1000–100000 | `5000` | Linie (renderer i headless). |
| `terminal.renderer` | `'dom' \| 'webgl'` | `'dom'` | ADR-009. |
| `terminal.copyOnSelect` | boolean | `false` | |
| `terminal.ctrlCBehavior` | `'copyIfSelection' \| 'alwaysSigint'` | `'copyIfSelection'` | |
| `terminal.ctrlVBehavior` | `'paste' \| 'passthrough'` | `'paste'` | |
| `terminal.rightClickBehavior` | `'copyPaste' \| 'menu'` | Windows `'copyPaste'`, inne `'menu'` | |
| `terminal.shiftEnterSequence` | string | `"\u001b\r"` | Pusty = brak mapowania. |
| `terminal.confirmMultilinePaste` | boolean | `true` | |
| `terminal.osc52` | `'allow' \| 'ask' \| 'deny'` | `'allow'` | Zapis schowka przez aplikacje. |
| `terminal.confirmOnKill` | `'always' \| 'whenProcessRunning' \| 'never'` | `'whenProcessRunning'` | |
| `terminal.confirmOnQuit` | boolean | `true` | |
| `terminal.closeOnExit` | `'never' \| 'ifClean' \| 'always'` | `'ifClean'` | |
| `terminal.restoreScrollback` | boolean | `true` | Snapshot przy wyjściu i odtworzenie przy starcie. |
| `terminal.persistScrollbackLines` | number | `1000` | Limit linii zapisywanych przy wyjściu. |
| `terminal.env` | `Record<string, string \| null>` | `{}` | |
| `terminal.windows.useBundledConpty` | boolean | `true` | `useConptyDll` node-pty. |
| `terminal.macOptionIsMeta` | boolean | `false` | |
| `terminal.fileLinkAction` | `'smart' \| 'editor' \| 'diff'` | `'smart'` | [04 §8.1](04-terminals.md). |
| `terminal.dimInactive` | boolean | `false` | |
| `terminal.screenReaderMode` | boolean | `false` | |
| `terminal.shellIntegration` | boolean | `true` (od M7) | |
| `terminal.images` | boolean | `false` | Sixel/IIP. |
| `workspace.keepAliveProjects` | number 1–10 | `4` | LRU zamontowanych workspace'ów. |
| `workspace.restoreOnStartup` | boolean | `true` | Odtwarzanie układów i terminali. |
| `workspace.openLastProject` | boolean | `true` | |
| `git.enabled` | boolean | `true` | |
| `git.path` | string \| null | `null` | Ścieżka do git. |
| `git.ignoredFolders` | string[] | lista z [06 §3.1](06-git-changes.md) | Ignorowane przez watcher. |
| `git.maxFiles` | number | `5000` | |
| `git.watchInactiveProjects` | boolean | `true` | Watcher dla projektów z terminalami w tle (wyłączany po 10 min bezczynności). |
| `git.periodicRefreshSeconds` | number 0–300 | `15` | 0 = wyłączone. |
| `git.diff.sideBySide` | boolean | `true` | |
| `git.diff.ignoreWhitespace` | boolean | `false` | |
| `git.diff.hideUnchangedRegions` | boolean | `true` | |
| `git.diff.maxFileSizeMb` | number | `2` | |
| `git.confirmDiscard` | boolean | `true` | M8. |
| `editor.preset` | `'auto' \| 'vscode' \| 'cursor' \| 'windsurf' \| 'zed' \| 'jetbrains' \| 'sublime' \| 'notepadpp' \| 'terminal' \| 'system' \| 'custom'` | `'auto'` | §4. |
| `editor.command` | string | `""` | Dla `custom`/`terminal`; placeholdery `${file}`, `${line}`, `${column}`, `${projectRoot}`. |
| `notifications.os` | boolean | `true` | Powiadomienia systemowe. |
| `notifications.agentWaiting` | boolean | `true` | |
| `notifications.agentFinished` | boolean | `true` | |
| `notifications.agentFinishedMinSeconds` | number | `30` | |
| `notifications.processError` | boolean | `true` | In-app. |
| `notifications.flashTaskbar` | boolean | `true` | |
| `notifications.doNotDisturb` | boolean | `false` | |
| `plugins.enabled` | `Record<string, boolean>` | `{}` | |
| `plugins.developerMode` | boolean | `false` | |
| `plugins.devPaths` | string[] | `[]` | |
| `diagnostics.logLevel` | `'error' \| 'warn' \| 'info' \| 'debug'` | `'info'` | |

Klucze wtyczek (np. `usage.*`) — ze schematów `contributes.configuration` ([07 §8.5](07-plugin-engine.md)); walidowane przy włączonej wtyczce.

### 3.3 Typy i dostęp

- `src/shared/domain/settings.ts`: `SettingsSchema` (zod) generujący typ `Settings` (obiekt zagnieżdżony po rozbiciu kluczy z kropkami) + funkcje `get(settings, 'terminal.fontSize')` typowane po ścieżce.
- Renderer: `useSettings(selector)` (Zustand) zasilany eventem `settings:changed`.
- Zmiany wymagające restartu elementu (np. `terminal.renderer`) stosowane na żywo tam, gdzie to możliwe (renderer: przełączenie addonu), w innych przypadkach komunikat „Applied to new terminals”.

## 4. Integracja z edytorem („Open in editor”)

| Preset | Polecenie (argv) | Wykrywanie (`auto`) |
|---|---|---|
| VS Code | `code --goto ${file}:${line}:${column}` | `code` w PATH |
| Cursor | `cursor --goto ${file}:${line}:${column}` | `cursor` w PATH |
| Windsurf | `windsurf --goto ${file}:${line}:${column}` | `windsurf` w PATH |
| Zed | `zed ${file}:${line}:${column}` | `zed` w PATH |
| JetBrains | `idea --line ${line} --column ${column} ${file}` (lub `webstorm`, `pycharm`, `rider`… — pierwszy znaleziony) | launchery w PATH |
| Sublime Text | `subl ${file}:${line}:${column}` | `subl` w PATH |
| Notepad++ | `notepad++ -n${line} -c${column} ${file}` | domyślna ścieżka instalacji |
| Terminal (np. Neovim) | `editor.command`, np. `nvim +${line} ${file}` — **otwierane w nowym panelu terminala Oxytocin** | — |
| System | `shell.openPath(file)` | fallback |

- `auto`: kolejność VS Code → Cursor → Windsurf → Zed → JetBrains → Sublime → System; wynik cache'owany, widoczny w UI ustawień.
- Wykonanie **bez powłoki**: szablon parsowany do argv (własny prosty parser z obsługą cudzysłowów), placeholdery podstawiane **per argument** (brak wstrzyknięcia komend). Na Windows launchery `.cmd` (np. `code.cmd`) wymagają `cmd.exe /d /s /c` — argumenty cytowane zgodnie z regułami cmd (escapowanie `^`, `&`, `|`, `%`); ścieżki weryfikowane jako istniejące pliki przed wywołaniem.
- Proces edytora uruchamiany `detached`, `stdio: 'ignore'`, `unref()`.

## 5. Wersjonowanie i migracje plików

- Każdy plik stanu ma pole `version` (liczba całkowita). `settings.json` nie ma wersji w treści — migracje kluczy przez mapę `renamedKeys` (`{ 'terminal.rendererType': 'terminal.renderer' }`) stosowaną przy odczycie (wartość przenoszona, stary klucz usuwany przy najbliższym zapisie z UI).
- Migracje w `src/main/services/*/migrations.ts`: `migrate(raw: unknown): Current` — sekwencja funkcji `v1→v2→…`; testy jednostkowe dla każdej migracji z przykładowymi plikami.
- Nowsza wersja pliku niż obsługiwana (downgrade aplikacji) → odczyt w trybie tylko-do-odczytu z ostrzeżeniem; brak zapisu, by nie zniszczyć danych.

## 6. Porządki i retencja

| Dane | Retencja / sprzątanie |
|---|---|
| `workspaces/<id>.json` usuniętych projektów | usuwane przy usunięciu projektu; przy starcie usuwane sieroty |
| Snapshoty scrollback | nadpisywane przy każdym wyjściu; usuwane wraz z panelem |
| `discard-backup/` | 7 dni (sprzątanie przy starcie) |
| Logi | rotacja 5 MB × 3 |
| Dane wtyczek | zarządzane przez wtyczki (Usage: `usage.retentionDays`); „Delete plugin data” w menedżerze |
| Crashpad | ostatnie 10 zrzutów |

## 7. Stan UI (`ui-state.json`)

```ts
interface UiState {
  version: 1;
  window: { x?: number; y?: number; width: number; height: number; maximized: boolean; displayId?: number };
  sidebar: { width: number; collapsed: boolean };
  paneview: { order: string[]; sizes: Record<string, number>; collapsed: string[]; hidden: string[] };
  pluginViewState: Record<string, unknown>;   // setState widoków sidebara wtyczek
  dismissedHints: string[];
}
```
Przywracanie okna: jeśli zapisane `x/y` leżą poza wszystkimi obecnymi ekranami (`screen.getAllDisplays()`), wyśrodkuj na ekranie głównym.

## 8. Sekrety

W v1 brak sekretów trwałych (token OTLP jest lokalny, losowy i przechowywany w storage wtyczki). Na przyszłość (np. tokeny integracji): `safeStorage.encryptString` (DPAPI/Keychain/libsecret) — nigdy w `settings.json`.
