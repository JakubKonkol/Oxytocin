# 03 — Domena 1: Projekty i przestrzeń robocza

Wymagania: **R-WS-1** (wiązanie folderów), **R-WS-2** (wizualny status aktywności), **R-WS-3** (przełączanie w locie).

## 1. Model danych

```ts
// src/shared/domain/project.ts
export type ProjectId = string;               // nanoid(12), stabilny

export interface Project {
  id: ProjectId;
  name: string;                               // domyślnie nazwa folderu; edytowalna
  rootPath: string;                           // absolutna, znormalizowana (path.resolve, natywne separatory, bez końcowego separatora)
  color: ProjectColor;                        // jeden z 10 kolorów palety (auto z hash(rootPath)), do awatara
  icon?: { kind: 'letter' | 'emoji'; value: string };
  pinned: boolean;
  order: number;                              // kolejność na liście (pinned zawsze na górze)
  createdAt: number;
  lastOpenedAt?: number;
  missing?: boolean;                          // runtime: folder nie istnieje (nie zapisywane)
  settings: ProjectSettings;
}

export interface ProjectSettings {
  defaultProfileId?: string;                  // profil terminala dla nowych terminali w projekcie
  env?: Record<string, string | null>;        // dodatkowe/usuwane zmienne środowiskowe
  startupTerminals?: StartupTerminal[];       // „zadania startowe” przy pierwszym otwarciu (pusty workspace)
  editorCommand?: string;                     // nadpisanie globalnego edytora
  git?: { enabled?: boolean; ignoredFolders?: string[] };
}

export interface StartupTerminal {
  name?: string;
  profileId?: string;
  command?: string;                           // wpisywane do powłoki po starcie (np. "npm run dev"), albo profil agenta
  cwd?: string;                               // względna do rootPath
  placement?: 'tab' | 'right' | 'below';
}

export type ProjectActivity = 'none' | 'idle' | 'running' | 'agent-working' | 'attention' | 'error';

export interface ProjectRuntimeStatus {
  projectId: ProjectId;
  activity: ProjectActivity;
  terminals: number;
  runningProcesses: number;
  agents: { working: number; waiting: number; idle: number };
  unseenError?: { terminalId: string; exitCode: number; at: number };
  gitBranch?: string;                         // z GitService (tylko dla projektów z aktywnym watcherem)
  changesCount?: number;
}
```

Plik: `userData/projects.json` → `{ version: 1, projects: Project[], activeProjectId: ProjectId | null }` (zapisy atomowe, [09](09-persistence-settings.md)).

## 2. ProjectService (main)

```ts
class ProjectService {
  list(): Project[];
  get(id): Project | undefined;
  add(path: string): Promise<Project>;              // walidacja + dedupe + zapis + event
  remove(id, opts: { killTerminals: boolean }): Promise<void>;
  update(patch: ProjectPatch): Promise<Project>;    // name, color, icon, pinned, settings
  reorder(ids: ProjectId[]): Promise<void>;
  setActive(id): Promise<void>;                      // aktualizuje lastOpenedAt, activeProjectId; event 'projects:active'
  findByPath(path): Project | undefined;             // najdłuższy prefiks (dla atrybucji cwd → projekt)
  onDidChange: Event<Project[]>;
}
```

### 2.1 Walidacja przy dodawaniu

1. `path.resolve` + `fs.realpath.native` (rozwiązanie symlinków/junction na Windows, poprawna wielkość liter).
2. Musi istnieć i być katalogiem; w przeciwnym razie `OxyError('INVALID')`.
3. **Dedupe**: porównanie znormalizowane (Windows i macOS: case-insensitive; Linux: case-sensitive). Jeśli już istnieje → zwróć istniejący i aktywuj go (bez błędu).
4. Zagnieżdżenie (dodawany folder jest wewnątrz istniejącego projektu lub odwrotnie) — dozwolone, ale z ostrzeżeniem w toście („Project ‘x’ contains this folder”). Atrybucja zużycia wybiera najdłuższy pasujący prefiks.
5. Odrzucenie katalogów systemowych/zbyt szerokich: root dysku (`C:\`), katalog domowy, `C:\Windows`, `/` — z komunikatem „Choose a project folder, not a whole drive or your home folder” (możliwość wymuszenia przez przytrzymanie Shift nie jest potrzebna w MVP).
6. Nazwa domyślna: `path.basename(root)`; kolor: `hash(root) % 10`.

### 2.2 Folder zniknął

- Przy starcie i przy aktywacji projektu `fs.stat(root)`; brak → `missing: true` (runtime).
- UI: element listy wyszarzony z ikoną ⚠; kliknięcie → EmptyState w centrum: „Folder not found: C:\…” + „Locate folder…” (dialog → `update({ rootPath })`, zachowuje id, układ i historię kosztów) + „Remove from list”.

## 3. Sposoby dodania projektu

| Sposób | Implementacja |
|---|---|
| Przycisk „+” w nagłówku sekcji / Ctrl+Shift+A / menu Plik | `projects:pickFolder` → `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })` → `projects:add`. |
| Przeciągnięcie folderu z Eksploratora na sidebar (lub na okno) | `dragover`/`drop` w rendererze; ścieżka przez `window.oxy.getPathForFile(file)` (preload, `webUtils`); tylko katalogi (pliki → toast „Drop a folder”). Strefa drop podświetlona `--accent`. |
| Linia poleceń `Oxytocin.exe C:\dev\api` | argv przy starcie i `second-instance` → `add` + `setActive`. |
| Ekran powitalny | przycisk + strefa drop. |
| (M9) Menu kontekstowe Eksploratora „Open in Oxytocin” | wpis rejestru dodawany przez instalator NSIS (opcjonalny checkbox). |

## 4. Lista projektów — UI

### 4.1 Anatomia elementu (32 px)

```
[StatusDot] [Awatar 18px] Nazwa projektu        ⎇ feature/x   [badge]
```
- Awatar: litera/emoji na tle koloru projektu (radius 4 px).
- Gałąź: widoczna tylko przy szerokości sidebara ≥ 280 px, obcięta z wielokropkiem.
- Badge (priorytet): `⚠ n` (agenci czekający, pomarańczowy) > `ACTIVE` (aktywny projekt, jak w prototypie) > liczba zmian `7` (neutralny, gdy znana).
- Tooltip elementu: pełna ścieżka, stan słownie, liczba terminali/agentów, ostatnie otwarcie.

### 4.2 Interakcje

- Klik → przełączenie (R-WS-3). Środkowy klik → nic (zarezerwowane). Dwuklik na nazwie → zmiana nazwy inline.
- Przeciąganie elementów → zmiana kolejności (`projects:reorder`), wizualny wskaźnik wstawienia; przypięte zawsze w grupie „Pinned” na górze.
- Menu kontekstowe: Open · New terminal in project · Rename · Color and icon · Pin/Unpin · Open in editor · Reveal in Explorer · Copy path · Project settings… (M7) · Remove from Oxytocin… (dialog: „Also close its N terminals?” — jeśli terminale działają, domyślnie zaznaczone; procesy są zabijane tylko po potwierdzeniu).
- Filtr (ikona lupy w nagłówku, gdy > 8 projektów): filtrowanie po nazwie/ścieżce.
- Skróty: Ctrl+Alt+1…9, Ctrl+Alt+↑/↓, Ctrl+Shift+E (fokus listy) + strzałki + Enter.

### 4.3 Sekcja „Recent”

Brak osobnej sekcji w MVP — sortowanie ręczne + przypinanie wystarcza. (Quick Open w M7 sortuje po `lastOpenedAt`.)

## 5. Status aktywności (R-WS-2)

### 5.1 Źródła sygnałów (szczegóły w [04-terminals.md §9](04-terminals.md))

Dla każdego terminala `TerminalInfo` utrzymywany w main (`TerminalService` + `AgentService`):
- `status` (`starting`/`running`/`exited`), `exitCode`,
- `kind` (`shell`/`process`/`agent`) — z monitora procesów,
- `agent.state` (`working`/`idle`/`waiting`/`unknown`) — z rejestru sesji Claude Code, sygnałów OSC i heurystyk wyjścia,
- `lastOutputAt`, `bell`, `progress`.

### 5.2 Agregacja do `ProjectActivity` (priorytet malejący)

```ts
function deriveActivity(ts: TerminalInfo[], seen: SeenState): ProjectActivity {
  if (ts.length === 0) return 'none';
  if (ts.some(t => t.agent?.state === 'waiting')) return 'attention';
  if (ts.some(t => t.status === 'exited' && t.exitCode !== 0 && !seen.has(t.id))) return 'error';
  if (ts.some(t => t.agent?.state === 'working')) return 'agent-working';
  if (ts.some(t => t.kind === 'process' || (t.kind === 'agent' && t.agent?.state !== 'idle'))) return 'running';
  return 'idle';
}
```
- `AgentService` przelicza aktywność przy każdej zmianie terminala (debounce 100 ms) i emituje `projects:activity` tylko dla zmienionych projektów.
- „Widziane” (`seen`): błąd zakończenia jest „widziany”, gdy panel terminala był widoczny i miał fokus ≥ 1 s po zakończeniu.
- Kolory/animacje wg [02 §6](02-ui-ux.md). Zmiana aktywności na `attention` uruchamia system powiadomień ([02 §9](02-ui-ux.md)).

## 6. Przełączanie w locie (R-WS-3)

### 6.1 Cel i gwarancje

- Kliknięcie projektu → widok poprzedniego projektu jest **zamrażany** (ukryty, bez renderowania), widok klikniętego **przywracany** z identycznymi terminalami, układem, pozycjami scrolla i widokami wtyczek.
- **Żaden proces nie jest przerywany** — PTY żyją w PTY Host niezależnie od rendererów.
- Czas: < 100 ms dla projektu zamontowanego; < 400 ms dla rehydratacji (5 terminali × 5000 linii).

### 6.2 Mechanizm: zamontowane workspace'y + LRU

```tsx
// src/renderer/src/shell/WorkspaceHost.tsx (szkic)
export function WorkspaceHost() {
  const activeId = useProjects(s => s.activeProjectId);
  const mounted = useWorkspaces(s => s.mountedIds);      // LRU, max = settings.workspace.keepAliveProjects (domyślnie 4)
  return (
    <div className="relative h-full">
      {mounted.map(id => (
        <div key={id} className="absolute inset-0" style={{ display: id === activeId ? 'block' : 'none' }}
             data-project-id={id} aria-hidden={id !== activeId}>
          <ProjectWorkspace projectId={id} active={id === activeId} />
        </div>
      ))}
    </div>
  );
}
```

- **Ukrycie** (`display: none`): xterm przestaje renderować (brak zmian w DOM; xterm wstrzymuje render, gdy element nie jest widoczny), ale dalej **parsuje dane** z portu, więc bufor jest aktualny. Dockview nie przelicza układu. Iframe'y wtyczek żyją (mogą dostać `visibility: hidden` przez SDK).
- **Pokazanie**: `ProjectWorkspace` z `active=true` → `dockviewApi.layout(w, h)` po `requestAnimationFrame`, `fit()` każdego widocznego terminala, fokus na ostatnio aktywny panel projektu, `terminal.refresh(0, rows-1)`.
- **Zamrażanie kosztów**: dla ukrytych workspace'ów — WebGL addon (jeśli używany) jest zwalniany (`dispose`), by nie trzymać kontekstów GPU (limit Chromium ~16 kontekstów na stronę); przy pokazaniu tworzony ponownie.
- **LRU**: przy przekroczeniu `keepAliveProjects` najdawniej używany workspace jest **odmontowywany**: instancje xterm `dispose()`, porty `detach`; PTY i lustro headless żyją dalej. Stan układu dockview jest już zapisany (§7).
- **Rehydratacja** (projekt spoza LRU): `workspace:load` → `fromJSON` → każdy `TerminalPanel` wykonuje `attach(terminalId)` → PTY Host odsyła **snapshot** (`serialize`) + numer sekwencji → xterm `write(snapshot)` → dalszy strumień na żywo ([04 §5](04-terminals.md)). Scroll ustawiany na dół (pozycja scrolla sprzed eviction nie jest zachowywana — akceptowalne).

### 6.3 Diagram stanów workspace'u

```
            open/activate                      evict (LRU)
 [unmounted] ───────────────► [mounted:visible] ───────────┐
      ▲                          │     ▲                   │
      │                 switch   │     │ switch back       │
      │                  away    ▼     │ (<100 ms)         │
      │                    [mounted:hidden] ───────────────┤
      └────────────────────────────────────────────────────┘
                 (rehydratacja przy ponownym otwarciu, <400 ms)
```

### 6.4 Co jeszcze jest „per projekt”

- Stan sidebara Zmian (rozwinięte foldery, zaznaczenie, tryb drzewo/lista) — w `WorkspaceState.ui`.
- Ostatnio aktywny panel.
- Watcher git: aktywny dla projektu aktywnego + projektów z żywymi terminalami (by liczniki zmian na liście były aktualne); zatrzymywany po 10 min bez terminali i bez aktywności (ustawienie `git.watchInactiveProjects`).

## 7. Stan workspace'u i przywracanie po restarcie

```ts
// src/shared/domain/workspace.ts
export interface WorkspaceState {
  version: 1;
  projectId: ProjectId;
  savedAt: number;
  dockview: unknown;                             // wynik DockviewApi.toJSON() (walidowany luźno: z.record)
  panels: Record<string, PanelDescriptor>;       // klucz = panelId dockview
  activePanelId?: string;
  ui: { changes?: { expanded: string[]; mode: 'tree' | 'list'; filter?: string } };
}

export type PanelDescriptor =
  | { kind: 'terminal'; terminalId?: string; profileId: string; cwd: string; userTitle?: string;
      agent?: { agentId: string; sessionId?: string };   // do „Resume session” (M7)
      scrollbackFile?: string }                           // względna ścieżka snapshotu zapisanego przy wyjściu
  | { kind: 'diff'; path: string; oldPath?: string; pinned: boolean }
  | { kind: 'plugin'; pluginId: string; panelType: string; params?: unknown; state?: unknown }
  | { kind: 'welcome' };
```

- **Zapis**: `onDidLayoutChange` dockview + zmiany deskryptorów → debounce 1 s → `workspace:save` (main zapisuje atomowo `userData/workspaces/<projectId>.json`). Flush przy wyjściu.
- **Przy restarcie aplikacji** (procesy nie przeżyły): dla każdego panelu `terminal` tworzony jest **nowy** terminal z tym samym profilem i cwd — **leniwie**: dla projektu aktywnego od razu, dla pozostałych dopiero przy ich pierwszym otwarciu (nie uruchamiamy procesów w tle bez wiedzy użytkownika). Jeśli `terminal.restoreScrollback` (domyślnie `true`) i istnieje `scrollbackFile` → przed startem powłoki do xterm zapisywany jest zapisany snapshot, a pod nim wyszarzony separator `── Session restored · Sep 26, 2026 6:42 PM ──`. (Implementacja: snapshot zapisujemy do headless nowego terminala przed spawnem, więc rehydratacja i persystencja mają jedno źródło prawdy.)
- Terminale z agentem (`agent.sessionId` znany): w M7 pod separatorem pojawia się pasek akcji „Resume Claude Code session (claude --resume …)” — **nigdy nie uruchamiamy agenta automatycznie**.
- **Pusty workspace przy pierwszym otwarciu projektu**: jeśli `settings.startupTerminals` → utwórz wg definicji; w przeciwnym razie jeden terminal z profilem domyślnym.
- Nieznany typ panelu przy przywracaniu (np. wtyczka odinstalowana) → panel zastępczy „Plugin ‘x’ is unavailable” z przyciskiem „Close”; deskryptor zachowany do czasu zamknięcia.

## 8. Ustawienia projektu (M7 — UI; model od M3)

Okno dialogowe / panel: nazwa, kolor, ikona, profil domyślny, zmienne środowiskowe (tabela klucz/wartość, „usuń zmienną” = `null`), zadania startowe (lista z drag&drop), edytor, ignorowane foldery watchera. Zmiany env dotyczą **nowych** terminali (istniejące dostają znacznik „środowisko nieaktualne” — [04 §2.4](04-terminals.md)).

## 9. Przypadki brzegowe

| Przypadek | Zachowanie |
|---|---|
| Ten sam folder dodany dwukrotnie / inną wielkością liter | Dedupe → aktywacja istniejącego. |
| Folder na dysku sieciowym / wolnym | `fs.stat` z timeoutem 3 s; watcher git może nie działać (fallback: odświeżanie okresowe co 10 s, gdy okno ma fokus). |
| Projekt w WSL (`\\wsl$\...`) | MVP: dozwolony jako ścieżka, ale terminal domyślny = WSL z `--cd`; git przez `wsl git`? — **poza MVP**, w MVP ostrzeżenie „Full WSL support is coming in a future version”. |
| Usunięcie aktywnego projektu | Aktywacja następnego na liście lub ekran powitalny. |
| 50+ projektów | Lista wirtualizowana; watchery tylko dla aktywnych (§6.4). |
| Zmiana nazwy folderu na dysku podczas pracy | Traktowane jak „Folder not found” przy następnym sprawdzeniu (aktywacja, fokus okna). |

## 10. Kryteria akceptacji (M3)

- [ ] Dodanie projektu każdym z 3 sposobów (dialog, DnD, CLI/second-instance); duplikat aktywuje istniejący.
- [ ] Projekt A: uruchomiony `node -e "setInterval(()=>console.log(Date.now()),200)"`; przełączenie na B i powrót po 30 s → bufor A zawiera wszystkie linie z tego okresu, proces działa (E2E).
- [ ] Przełączenie między dwoma zamontowanymi projektami < 100 ms (mierzone `performance.mark`, średnia z 20 prób w E2E, próg 150 ms na CI).
- [ ] Po otwarciu 5 projektów przy `keepAliveProjects=4` pierwszy jest odmontowany, a powrót do niego odtwarza bufor (rehydratacja) z zachowaniem kolorów ANSI.
- [ ] Kropki statusu: `running` przy działającym procesie potomnym, `agent-working`/`attention` dla fikcyjnego agenta z fixture ([10 §3](10-quality-testing-release.md)), `error` po `exit 3`.
- [ ] Restart aplikacji odtwarza listę projektów, aktywny projekt, układ paneli i scrollback z separatorem.
- [ ] Usunięcie projektu z działającymi terminalami wymaga potwierdzenia i zabija procesy tylko po potwierdzeniu.
