# 04 — Domena 3: Terminale (PTY Host, xterm.js, agenci AI)

Wymagania: **R-TERM-1** (pełny TTY), **R-TERM-3** (persystencja sesji), wsparcie **R-WS-2** (status aktywności). Podziały i panele: [05-layout-center.md](05-layout-center.md).

## 1. Przegląd przepływu danych

```
 klawiatura ──► xterm (renderer) ──input──► [MessagePort] ──► PTY Host ──► node-pty ──► powłoka/agent
                                                                  │
 ekran ◄── xterm.write ◄──data(seq)── [MessagePort] ◄── batcher ◄─┴─ onData ──► @xterm/headless (lustro)
                                                                              └► OSC handlers ─► main (tytuł, BEL, progress, notyfikacje)
 ProcessMonitor (co 1–5 s) ──► main.AgentService ──► renderer (badge, kropki) / Plugin Host (oxy.agents)
```

- **Źródło prawdy bufora = PTY Host** (headless). Renderer to „widok”, który można zniszczyć i odtworzyć.
- Input i output nie przechodzą przez main (niskie opóźnienie). Operacje sterujące (create/kill/rename) przechodzą przez main, bo main prowadzi rejestr i persystencję.

## 2. Tworzenie terminala

### 2.1 Profile

```ts
// src/shared/domain/terminal.ts
export interface TerminalProfile {
  id: string;                         // 'pwsh', 'powershell', 'cmd', 'git-bash', 'wsl:Ubuntu', 'bash', 'zsh', 'fish', 'agent:claude', 'custom:<nanoid>'
  name: string;                       // „PowerShell 7”, „Claude Code”
  kind: 'shell' | 'agent';
  file: string;                       // absolutna ścieżka lub nazwa w PATH (rozwiązywana przy spawnie)
  args: string[];
  env?: Record<string, string | null>;
  icon?: string;                      // codicon / id ikony
  platform?: NodeJS.Platform[];
  hidden?: boolean;                   // wykryty, ale ukryty przez użytkownika
  source: 'detected' | 'builtin-agent' | 'user' | 'plugin';
  shellForAgent?: string;             // dla profili agentów: w jakiej powłoce uruchomić komendę (domyślnie profil domyślny)
  command?: string;                   // dla profili agentów: np. "claude"
}
```

**Wykrywanie (main, `services/terminals/shell-detect`), cache 1 h, odświeżane poleceniem:**

| Platforma | Profil | Wykrycie | Argumenty |
|---|---|---|---|
| Windows | PowerShell 7 (`pwsh`) | PATH (`where pwsh`), `%ProgramFiles%\PowerShell\7\pwsh.exe`, Microsoft Store alias | `-NoLogo` |
| Windows | Windows PowerShell | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | `-NoLogo` |
| Windows | Command Prompt | `%ComSpec%` | — |
| Windows | Git Bash | `%ProgramFiles%\Git\bin\bash.exe`, rejestr `HKLM\SOFTWARE\GitForWindows\InstallPath` | `--login -i` |
| Windows | WSL: `<distro>` | `wsl.exe -l -q` (**wyjście w UTF-16LE** — dekodować, usunąć `\0`) | `-d <distro> --cd <cwd>` (cwd jako ścieżka Windows — wsl.exe ją tłumaczy) |
| macOS/Linux | `$SHELL` | env | `-l` (login) |
| macOS/Linux | bash / zsh / fish | `/etc/shells` + PATH | `-l` (fish: `-l`) |

Domyślny profil: ustawienie `terminal.defaultProfile.<platform>`; brak → Windows: `pwsh` jeśli jest, inaczej `powershell`; POSIX: `$SHELL`.

**Profile agentów (wbudowane, widoczne tylko gdy binarka jest w PATH):** „Claude Code” (`claude`), „Codex CLI” (`codex`), „Gemini CLI” (`gemini`), „Aider” (`aider`), „OpenCode” (`opencode`). Uruchamiane jako **powłoka domyślna + komenda wpisana po starcie** (np. `claude\r`), a nie jako bezpośredni proces PTY — dzięki temu po wyjściu z agenta użytkownik zostaje w powłoce, a historia komend działa. Implementacja: po pierwszym outputcie powłoki (lub 300 ms) PTY Host wysyła `command + '\r'`. (Z shell integration w M7 — po sekwencji „prompt gotowy”.)

### 2.2 Żądanie utworzenia

```ts
export interface CreateTerminalRequest {
  projectId: ProjectId;
  profileId?: string;                 // brak → profil domyślny projektu/globalny
  cwd?: string;                       // brak → rootPath projektu; walidacja istnienia (fallback rootPath)
  cols?: number; rows?: number;       // z renderera, jeśli panel już ma rozmiar; domyślnie 120×30
  userTitle?: string;
  restoreFrom?: { scrollbackFile: string };   // revive po restarcie
  initialCommand?: string;            // np. z StartupTerminal
}
```

`TerminalService.create()` (main): rozwiązuje profil → składa env (§2.3) → czeka na „gotowość env” wtyczek (maks. 2 s przy starcie aplikacji, [07 §8.7](07-plugin-engine.md)) → `ptyHost.spawn(...)` → rejestruje `TerminalInfo` → emituje `terminals:updated`.

Opcje `node-pty` na Windows: `{ name: 'xterm-256color', cols, rows, cwd, env, useConpty: true, useConptyDll: settings.terminal.windows.useBundledConpty /* domyślnie true */, conptyInheritCursor: false }`. POSIX: `{ name: 'xterm-256color', cols, rows, cwd, env, encoding: 'utf8' }`.

### 2.3 Składanie zmiennych środowiskowych (kolejność — późniejsze nadpisują)

1. **Bazowe:** `process.env` main (macOS/Linux: env rozwiązany z powłoki logowania — `ShellEnvService`, bo aplikacje GUI nie dziedziczą PATH z `.zshrc`).
2. **Czyszczenie** (usuń, jeśli obecne): `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`, `ELECTRON_*` (wszystkie), `NODE_OPTIONS` tylko jeśli ustawił je Electron/dev tooling (zachowaj, jeśli pochodzi od użytkownika — w praktyce: usuń tylko w trybie dev), `CHROME_*`, markery innych terminali/IDE: `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `VSCODE_*`, `WT_SESSION`, `WT_PROFILE_ID`, `TERMINAL_EMULATOR`, `ITERM_SESSION_ID`, `KITTY_*`, `ALACRITTY_*`, `WEZTERM_*`, `GHOSTTY_*`, `KONSOLE_*`, oraz markery sesji Claude Code odziedziczone, gdy Oxytocin uruchomiono z terminala z Claude Code (np. podczas developmentu): `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`. **Nie usuwaj** konfiguracji użytkownika (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CODE_USE_BEDROCK` itp.).
3. **Tożsamość terminala:** `TERM_PROGRAM=Oxytocin`, `TERM_PROGRAM_VERSION=<app version>`, `COLORTERM=truecolor`, `OXYTOCIN=1`, `OXYTOCIN_PROJECT_ID`, `OXYTOCIN_TERMINAL_ID`; POSIX: `TERM=xterm-256color`, `LANG` (jeśli brak, na macOS `en_US.UTF-8`).
4. `settings.terminal.env` (globalne).
5. `project.settings.env`.
6. **Wkłady wtyczek** (`EnvironmentCollection` z Plugin Host — [07 §8.7](07-plugin-engine.md)), w kolejności id wtyczek, z filtrem zakresu (`projectId`, `profileIds`); konflikt → wygrywa późniejsza + ostrzeżenie w logu. Wartości z podstawieniami `${env:NAME}` rozwijane względem env po krokach 1–5.
7. `profile.env`.

Wartość `null` = usuń zmienną. Na Windows klucze porównywane case-insensitive (`Path` vs `PATH`) — użyj mapy z normalizacją klucza.

### 2.4 „Środowisko nieaktualne”

Gdy po utworzeniu terminala zmieni się któreś ze źródeł 4–7, `TerminalInfo.envStale = true` → w nagłówku panelu ikona ⟳ z tooltipem „Environment variables changed — restart the terminal to apply them”. Klik → restart (z potwierdzeniem, jeśli działa proces).

## 3. PTY Host — moduły

### 3.1 `TerminalSession`

```ts
class TerminalSession {
  readonly id: TerminalId;
  readonly pty: IPty;
  readonly mirror: HeadlessMirror;       // @xterm/headless + SerializeAddon, te same cols/rows, scrollback = settings.terminal.scrollback
  private seq = 0;                       // numer ostatniego fragmentu danych
  private batcher: DataBatcher;          // łączy dane do 5 ms / 64 KB
  private flow: FlowController;
  private subscribers = new Set<RendererChannel>();
  lastOutputAt = 0;

  constructor(opts: SpawnOptions) {
    this.pty = spawn(opts.file, opts.args, opts.ptyOptions);
    this.pty.onData(d => this.onPtyData(d));
    this.pty.onExit(e => this.onExit(e));
  }
  private onPtyData(data: string) {
    this.lastOutputAt = Date.now();
    this.mirror.write(data);             // parsowanie VT; OSC handlers zarejestrowane na parserze headless
    this.batcher.push(data);             // flush → broadcast({ t:'data', id, seq: ++this.seq, data: chunk }) + flow.onSent(chunk.length)
  }
  write(data: string) { this.pty.write(data); }
  resize(cols: number, rows: number) { this.pty.resize(cols, rows); this.mirror.resize(cols, rows); }
  snapshot(opts?: { scrollback?: number }) { return { seq: this.seq, data: this.mirror.serialize(opts), cols, rows }; }
}
```

- **Kolejność gwarantowana:** snapshot i późniejsze `data` idą tym samym portem; `attach` jest obsługiwany synchronicznie w pętli zdarzeń hosta (najpierw `batcher.flush()`, potem `snapshot`, potem dodanie subskrybenta), więc nie ma luk ani duplikatów.
- `SerializeAddon.serialize()` — z zachowaniem bufora alternatywnego i trybów (np. bracketed paste, mouse tracking), aby TUI (Claude Code w trybie fullscreen, vim, htop) odtwarzały się poprawnie. Zweryfikować opcje addonu 0.14 (`excludeAltBuffer: false`, `excludeModes: false`) w spike S3.

### 3.2 Batching (`DataBatcher`)

Dane z PTY buforowane per terminal i wysyłane co **5 ms** lub po przekroczeniu **64 KB** (wzorzec `TerminalDataBufferer` z VS Code). Redukuje liczbę wiadomości przy dużym outpucie (np. `npm install`, logi serwera).

### 3.3 Flow control (`FlowController`)

- Liczymy znaki wysłane do renderera, a niepotwierdzone (`unacked`).
- Renderer potwierdza po przetworzeniu: `term.write(data, () => ackCounter += data.length)`; wysyła `ack` co ≥ 5 000 znaków.
- `unacked > HIGH_WATERMARK (100 000)` → `pty.pause()`; `unacked < LOW_WATERMARK (5 000)` → `pty.resume()`.
- **Gdy żaden renderer nie jest podłączony** (workspace odmontowany) → brak pauzy (headless konsumuje wszystko), bo proces w tle (np. serwer dev) nie może być blokowany przez niewidoczny widok.
- Gdy podłączony widok jest ukryty — xterm nadal parsuje i ACK-uje, więc przepływ nie staje.
- Timeout bezpieczeństwa: jeśli brak ACK przez 5 s przy pauzie → `resume()` + log ostrzeżenia (chroni przed zawieszeniem przy błędzie renderera).

### 3.4 Handlery OSC/sekwencji (`osc-handlers.ts`, rejestrowane na `mirror.parser`)

| Sekwencja | Znaczenie | Akcja |
|---|---|---|
| `OSC 0 ; t ST`, `OSC 2 ; t ST` | Tytuł okna | `terminal:title` (throttle 250 ms) → tytuł tabu (jeśli brak `userTitle`). |
| `BEL` (0x07 poza sekwencją) | Dzwonek | `terminal:bell` (throttle 1 s) → ikona na tabie, jeśli terminal niewidoczny. Wykrywanie: `mirror.onBell`. |
| `OSC 9 ; 4 ; st ; pr ST` | Pasek postępu (ConEmu/Windows Terminal) | `terminal:progress { state: 0 ukryty, 1 normalny, 2 błąd, 3 nieokreślony, 4 pauza/ostrzeżenie; value }` → sygnał stanu agenta (§9.4). |
| `OSC 9 ; <tekst> ST` (bez `4;`) | Notyfikacja iTerm2 | `terminal:notification { body }`. |
| `OSC 777 ; notify ; title ; body ST` | Notyfikacja rxvt/Ghostty | `terminal:notification { title, body }`. |
| `OSC 7 ; file://host/path ST` | Bieżący katalog (część powłok) | `terminal:cwd`. |
| `OSC 633 ; …` / `OSC 133 ; …` | Shell integration (M7) | §11. |
| `OSC 52` | Schowek | Obsługiwane w rendererze (`@xterm/addon-clipboard`) z polityką z ustawień (§7.5). |

Handlery zwracają `false` (nie konsumują), aby renderer też mógł przetworzyć sekwencję (np. tytuł, progress addon).

### 3.5 Monitor procesów (`process-monitor/`)

- Cykl adaptacyjny: co **1 s**, jeśli jakikolwiek terminal miał output w ostatnich 5 s; inaczej co **5 s**. Jedno zapytanie dla wszystkich terminali na cykl.
- **Windows:** `@vscode/windows-process-tree` `getProcessList(ptyPid, cb, ProcessDataFlag.CommandLine)` dla każdego terminala (natywne, szybkie). Ignoruj `conhost.exe`, `OpenConsole.exe`, `wslhost.exe`.
- **POSIX:** jedno wywołanie `ps -A -o pid=,ppid=,comm=,args=` (macOS: `ps -A -o pid=,ppid=,comm=,command=`), budowa drzewa w pamięci; dodatkowo `pty.process` (nazwa procesu pierwszoplanowego) z node-pty.
- Wynik per terminal: `{ descendants: {pid, ppid, name, commandLine}[], foreground?: {...} }` → do main (`terminal:process`) **tylko przy zmianie** (porównanie hash listy pid+name).
- Pomiar kosztu cyklu logowany w trybie debug; jeśli cykl > 250 ms → wydłużenie interwału ×2 (maks. 10 s).

## 4. Protokół wiadomości

### 4.1 Renderer ⇄ PTY Host (MessagePort)

```ts
// src/shared/rpc/contracts/pty-channel.ts
export type RendererToPty =
  | { t: 'attach'; id: TerminalId; cols?: number; rows?: number }      // rozpoczęcie subskrypcji; opcjonalnie od razu resize
  | { t: 'detach'; id: TerminalId }
  | { t: 'input'; id: TerminalId; data: string }
  | { t: 'binary'; id: TerminalId; data: string }                       // tryb binarny (np. mysz w niektórych TUI) — xterm onBinary
  | { t: 'resize'; id: TerminalId; cols: number; rows: number }
  | { t: 'ack'; id: TerminalId; chars: number };

export type PtyToRenderer =
  | { t: 'snapshot'; id: TerminalId; seq: number; data: string; cols: number; rows: number }
  | { t: 'data'; id: TerminalId; seq: number; data: string }
  | { t: 'exit'; id: TerminalId; exitCode: number; signal?: number }
  | { t: 'error'; id: TerminalId; code: 'NOT_FOUND' | 'DEAD'; message: string };
```

### 4.2 Main ⇄ PTY Host (RPC `createPortRpc`)

```ts
export interface PtyHostMethods {
  spawn(o: SpawnOptions): { pid: number };                     // SpawnOptions: id, file, args, cwd, env, cols, rows, ptyOptions, scrollback, restoreSnapshot?, initialCommand?
  kill(o: { id: TerminalId; force?: boolean }): void;          // force → tree-kill po 3 s
  list(): Array<{ id: TerminalId; pid: number; alive: boolean }>;
  serialize(o: { id: TerminalId; scrollback: number }): { seq: number; data: string };
  setScrollback(o: { scrollback: number }): void;
  shutdown(): void;
  ping(): 'pong';
}
export interface PtyHostEvents {
  'terminal:exit': { id; exitCode; signal? };
  'terminal:title': { id; title };
  'terminal:bell': { id };
  'terminal:progress': { id; state: 0|1|2|3|4; value?: number };
  'terminal:notification': { id; title?: string; body: string };
  'terminal:cwd': { id; cwd };
  'terminal:activity': { id; lastOutputAt };                   // throttle 1 s
  'terminal:process': { id; descendants: ProcInfo[]; foreground?: ProcInfo };
  'log': { level; message; meta? };
}
```

## 5. Attach, snapshot, rehydratacja

1. `TerminalPanel` montuje się → tworzy instancję xterm (§6) → `ptyChannel.attach(id, cols, rows)`.
2. PTY Host: flush batchera → `snapshot` → dodanie subskrybenta → dalsze `data` (seq > snapshot.seq).
3. Renderer: `term.reset()`; `term.write(snapshot.data)`; ustaw `lastSeq = snapshot.seq`; kolejne `data` z `seq <= lastSeq` odrzuca (ochrona przy wyścigach po reconnect).
4. Jeśli rozmiar kontenera różni się od `snapshot.cols/rows` → `resize` (xterm i PTY; bufor normalny się reflowuje; TUI przerysuje się po SIGWINCH).
5. Odmontowanie (`dispose` panelu) → `detach` → xterm `dispose()`.
6. Reload renderera → nowy port → wszystkie widoczne panele robią `attach` ponownie (identyczna ścieżka jak rehydratacja).

Rozmiar snapshotu: pełny scrollback (domyślnie 5000 linii) — typowo 0,2–2 MB tekstu z sekwencjami; zapis do xterm < 50 ms na terminal. Jeśli zmierzone czasy przekroczą budżet (400 ms dla 5 terminali), ogranicz snapshot do `min(scrollback, 2000)` linii przy rehydratacji w tle.

## 6. Renderer — `TerminalView`

### 6.1 Konfiguracja xterm

```ts
const term = new Terminal({
  fontFamily: settings.terminal.fontFamily,      // "Cascadia Mono, JetBrains Mono, Consolas, monospace"
  fontSize: settings.terminal.fontSize,          // 13
  lineHeight: settings.terminal.lineHeight,      // 1.2
  letterSpacing: 0,
  cursorStyle: settings.terminal.cursorStyle,    // 'bar' | 'block' | 'underline'
  cursorBlink: settings.terminal.cursorBlink,    // true
  scrollback: settings.terminal.scrollback,      // 5000
  allowProposedApi: true,                        // wymagane przez część addonów (unicode11, search decorations)
  allowTransparency: false,
  macOptionIsMeta: settings.terminal.macOptionIsMeta,
  rightClickSelectsWord: platform === 'darwin',
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  smoothScrollDuration: 0,
  theme: buildXtermTheme(tokens),
  windowsPty: isWindows ? { backend: 'conpty', buildNumber: osBuild } : undefined,   // dopasowanie heurystyk reflow do ConPTY
  // xterm ≥ 6.1: vtExtensions: { kittyKeyboard: true } (patrz §7.3)
});
```

### 6.2 Addony

| Addon | Użycie |
|---|---|
| `@xterm/addon-fit` | Dopasowanie cols/rows do kontenera (ResizeObserver + rAF + debounce 50 ms). Nie wywołuj, gdy kontener ma 0×0 (ukryty). |
| `@xterm/addon-unicode11` | Szerokości emoji/CJK (`term.unicode.activeVersion = '11'`). |
| `@xterm/addon-web-links` | URL-e → `shell:openExternal` (tylko http/https), Ctrl+Klik (konfigurowalne). |
| `@xterm/addon-search` | Wyszukiwarka (Ctrl+Shift+F): widget z polem, case/regex/whole word, podświetlenia (decorations). |
| `@xterm/addon-clipboard` | OSC 52 (zapis do schowka przez aplikacje, np. `/copy` w Claude Code) — polityka §7.5. |
| `@xterm/addon-progress` | Odczyt OSC 9;4 do wyświetlania paska postępu w nagłówku panelu (cienka linia pod nagłówkiem). |
| `@xterm/addon-webgl` | **Tylko gdy `terminal.renderer = 'webgl'`** (domyślnie `'dom'`, ADR-009). Przy `onContextLoss` → dispose i powrót do DOM. Limit aktywnych kontekstów: 8 (powyżej → DOM). Zwalniany dla ukrytych workspace'ów. |
| `@xterm/addon-image` | Opcjonalnie (ustawienie `terminal.images`, domyślnie off) — sixel/iTerm IIP. |

### 6.3 Cykl życia

`mount` → `new Terminal` → `loadAddons` → `term.open(container)` → `attach` → (widoczny) `fit` → fokus jeśli panel aktywny.
`hidden` (workspace ukryty / tab nieaktywny przy renderer `always`) → nic nie rób poza zwolnieniem WebGL (jeśli włączony).
`visible` → `fit` + `refresh` (+ WebGL).
`unmount` → `detach` → `dispose()` (addony dispose'ują się razem z terminalem).

Rejestr `terminalRegistry` (renderer) mapuje `terminalId → { term, panelId, projectId }` — używany przez polecenia (kopiuj, szukaj, fokus) i `KeybindingService`.

## 7. Klawiatura, schowek, wejście

### 7.1 Przechwytywanie skrótów

`term.attachCustomKeyEventHandler(e => handleKey(e))`: zwróć `false` (xterm nie obsłuży), jeśli `KeybindingService.resolve(e, 'terminalFocus')` znalazł polecenie (i je uruchom). Zasada z [02 §7](02-ui-ux.md): w terminalu przechwytujemy tylko kombinacje z Ctrl+Shift / Alt+Shift / Ctrl+Alt / F-klawisze oraz zdefiniowane wyjątki.

### 7.2 Kopiuj/wklej (domyślnie jak Windows Terminal)

| Klawisz | Zachowanie domyślne | Ustawienie |
|---|---|---|
| Ctrl+C | Jeśli jest zaznaczenie → kopiuj i wyczyść zaznaczenie (nie wysyłaj ^C); inaczej → `\x03` (SIGINT). | `terminal.ctrlCBehavior: 'copyIfSelection' \| 'alwaysSigint'` |
| Ctrl+V | Schowek zawiera tekst → `term.paste(text)` (bracketed paste obsługuje xterm). Schowek zawiera **tylko obraz** → wyślij surowe `\x16`, aby agent (Claude Code) sam odczytał obraz ze schowka. | `terminal.ctrlVBehavior: 'paste' \| 'passthrough'` |
| Ctrl+Shift+C / Ctrl+Shift+V | Zawsze kopiuj / wklej tekst. | — |
| Prawy przycisk myszy | Windows: zaznaczenie → kopiuj, brak → wklej (jak konsola Windows). macOS/Linux: menu kontekstowe. | `terminal.rightClickBehavior: 'copyPaste' \| 'menu'` |
| Zaznaczenie | Opcjonalnie kopiowanie przy zaznaczeniu. | `terminal.copyOnSelect` (domyślnie false) |

Schowek czytany przez IPC `clipboard:read` (moduł `clipboard` w main zwraca tekst i informację o obrazie) — renderer nie dostaje uprawnienia `clipboard-read`; kopiowanie przez `clipboard:writeText`.

Wklejanie wielu linii bez bracketed paste (tryb wyłączony przez aplikację) → ostrzeżenie „Paste N lines? Each line may be executed.” (ustawienie `terminal.confirmMultilinePaste`, domyślnie true).

### 7.3 Shift+Enter i agenci

- xterm 6.0 wysyła `\r` dla Shift+Enter. Claude Code traktuje **Meta+Enter (`\x1b\r`)** jako nową linię (to samo co Option+Enter). Domyślnie mapujemy Shift+Enter → `\x1b\r` (ustawienie `terminal.shiftEnterSequence`, pusta wartość = brak mapowania).
- Po wydaniu xterm 6.1 (kitty keyboard protocol, PR #5600): włączyć `vtExtensions.kittyKeyboard`; gdy aplikacja w terminalu aktywuje protokół kitty (flagi CSI > u), **wyłączyć** własne mapowanie Shift+Enter (natywna obsługa Claude Code ≥ 2.1.269). Zadanie w backlogu M7.
- Ctrl+Backspace → `\x08` (xterm domyślnie). Backspace → `\x7f` (poprawnie dla Claude Code na Windows — problem „Backspace kasuje słowo” dotyczy terminali wysyłających `^H`).

### 7.4 Przeciąganie plików do terminala

Drop plików/folderów z Eksploratora (lub z drzewa Zmian) na terminal → wklejenie ścieżek (oddzielone spacją) z cytowaniem zależnym od profilu: pwsh/powershell `'C:\a b\c.png'` (apostrof podwojony), cmd `"C:\a b\c.png"`, bash/zsh/fish/Git Bash `'…'` (Git Bash: konwersja `C:\x` → `/c/x`), WSL: `/mnt/c/...`. Przydatne do podawania agentom obrazów i plików.

### 7.5 OSC 52 (zapis schowka przez aplikację)

Polityka `terminal.osc52: 'allow' | 'ask' | 'deny'` (domyślnie `allow` tylko dla zapisu; odczyt schowka przez OSC 52 zawsze `deny`).

### 7.6 IME i dostępność

Kompozycja IME działa natywnie w xterm (textarea). `screenReaderMode` wg ustawienia.

## 8. Linki, wyszukiwanie, menu

### 8.1 Linki do plików

Własny `ILinkProvider` (`link-providers.ts`):
- Wzorce: `(?:[A-Za-z]:)?[\\/]?[\w.@\-+~ ]*[\\/]?[\w.@\-+~]+\.[A-Za-z0-9]{1,8}(?::(\d+))?(?::(\d+))?` oraz formaty `file(line,col)` (MSBuild/tsc) i `at file:line:col` (stack trace).
- Rozwiązanie względem: cwd terminala (znany z OSC 7/633 lub cwd startowy) → rootPath projektu. Weryfikacja istnienia batchowo przez main (`fs:statMany`, cache 5 s, maks. 50 kandydatów na widoczny ekran).
- Ctrl+Klik (akcja domyślna konfigurowalna `terminal.fileLinkAction`):
  1. plik `.md` i istnieje opener wtyczki → podgląd (Markdown Preview),
  2. plik zmieniony względem HEAD → panel diffu,
  3. w pozostałych przypadkach → „Open in editor” (`editor:open` z linią/kolumną).
- Tooltip linku podpowiada akcję i modyfikator.

### 8.2 Menu kontekstowe terminala

Copy · Paste · Select all · Find… · Clear · Split right / Split down · Rename · Restart · Close · (gdy agent) „Copy session ID”.

## 9. Wykrywanie agentów i stanu (AgentService)

### 9.1 Reguły wykrywania (`services/agents/rules.ts`, rozszerzalne przez wtyczki `contributes.agents`)

```ts
export interface AgentRule {
  id: string;                       // 'claude-code'
  displayName: string;              // 'Claude Code'
  provider: 'anthropic' | 'openai' | 'google' | 'multi' | 'other';
  processNames: string[];           // porównanie case-insensitive nazwy pliku bez rozszerzenia
  commandLinePatterns?: RegExp[];   // np. node uruchamiający pakiet npm
  icon: string;
}

export const DEFAULT_AGENT_RULES: AgentRule[] = [
  { id: 'claude-code', displayName: 'Claude Code', provider: 'anthropic', processNames: ['claude'],
    commandLinePatterns: [/@anthropic-ai[\\/]claude-code/i], icon: 'claude' },
  { id: 'codex', displayName: 'Codex CLI', provider: 'openai', processNames: ['codex'],
    commandLinePatterns: [/@openai[\\/]codex/i], icon: 'openai' },
  { id: 'gemini-cli', displayName: 'Gemini CLI', provider: 'google', processNames: ['gemini'],
    commandLinePatterns: [/@google[\\/]gemini-cli/i], icon: 'gemini' },
  { id: 'aider', displayName: 'Aider', provider: 'multi', processNames: ['aider'],
    commandLinePatterns: [/-m\s+aider\b/i, /[\\/]aider(\.exe)?\b/i], icon: 'aider' },
  { id: 'opencode', displayName: 'OpenCode', provider: 'multi', processNames: ['opencode'], icon: 'opencode' },
  { id: 'copilot-cli', displayName: 'GitHub Copilot CLI', provider: 'multi', processNames: ['copilot'],
    commandLinePatterns: [/@github[\\/]copilot/i], icon: 'copilot' },
  { id: 'cursor-agent', displayName: 'Cursor Agent', provider: 'multi', processNames: ['cursor-agent'], icon: 'cursor' },
  { id: 'qwen-code', displayName: 'Qwen Code', provider: 'other', processNames: ['qwen'],
    commandLinePatterns: [/@qwen-code/i], icon: 'qwen' },
];
```

Algorytm: dla potomków powłoki (BFS od pid PTY) wybierz **najbliższy** proces pasujący do reguły → `TerminalInfo.kind = 'agent'`, `agent = { agentId, pid, … }`. Jeśli brak agenta, ale istnieje dowolny potomek (poza ignorowanymi) → `kind = 'process'` (`foreground` = najpłytszy potomek, np. `node` z `npm run dev`). Brak potomków → `kind = 'shell'`.

Dla terminali uruchomionych profilem agenta (`agent:claude`) wstępnie `kind='agent'`, `state='starting'` do czasu potwierdzenia przez monitor procesów (maks. 10 s, potem zwykła klasyfikacja).

### 9.2 Stan agenta — model

```ts
export interface AgentInfo {
  agentId: string; displayName: string; provider: string;
  pid: number;
  sessionId?: string;                 // Claude: z rejestru; Codex/Gemini: z korelacji plików sesji (Usage Monitor może uzupełnić)
  state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown';
  waitingFor?: string;                // np. 'permission', 'input' (jeśli źródło podaje)
  stateSource: 'claude-registry' | 'osc-progress' | 'output-heuristic' | 'bell' | 'hook' | 'none';
  since: number;                      // znacznik czasu ostatniej zmiany stanu
}
```

### 9.3 Źródło 1 (Claude Code): rejestr sesji

- Katalog: `${CLAUDE_CONFIG_DIR ?? ~/.claude}/sessions/*.json` (plik `<pid>.json`; pomijaj pliki `.key` i inne).
- Obserwacja: `fs.watch(dir)` (lekki, pojedynczy katalog) + pełny rescan co 15 s (odporność na zgubione zdarzenia); parsowanie tolerancyjne (`zod` z `.passthrough()`, brakujące pola ignorowane).
- Dopasowanie: `registry.pid === agent.pid` (zweryfikowane: pid w pliku = pid `claude.exe`).
- Mapowanie statusu: `busy` → `working`; `idle` → `idle`; `waiting` → `waiting` (+`waitingFor`); `shell` → `working`; inne/nieznane → `unknown` (log debug z wartością, by rozszerzać mapowanie).
- Uzupełnia `sessionId`, `name` (tytuł sesji — do tooltipa), `cwd`.
- Fallback walidacyjny: jeśli katalog nie istnieje lub format nie pasuje (zmiana wersji Claude Code) → co 5 s `claude agents --json` (tylko gdy istnieje ≥ 1 wykryty agent Claude; timeout 5 s) — oficjalny interfejs „for scripting”.
- **Spike S5 (M3):** zarejestrować realne przejścia statusów (`busy`/`idle`/`waiting`/`shell`, pole `waitingFor`) podczas: promptu, prośby o zgodę na narzędzie, `!` komendy, pytania agenta; zapisać wynik w `docs/spikes/S5-claude-registry.md` i zaktualizować mapowanie.

### 9.4 Źródło 2: sygnały terminala (wszyscy agenci)

| Sygnał | Interpretacja |
|---|---|
| `OSC 9;4` stan 3 (nieokreślony) lub 1 | `working` |
| `OSC 9;4` stan 0 po okresie pracy | `idle` |
| `OSC 9;4` stan 4 (pauza/ostrzeżenie) | kandydat na `waiting` (do potwierdzenia w spike S5) |
| `BEL` lub notyfikacja OSC 9/777 | `waiting` (agent prosi o uwagę) — aż do następnego inputu użytkownika w tym terminalu |
| Output w ostatnich 2 s | `working` (heurystyka, tylko gdy brak lepszego źródła) |
| Brak outputu > 8 s po okresie pracy | `idle` (heurystyka) |
| Input użytkownika (klawisz Enter) w terminalu ze stanem `waiting` | → `working` (optymistycznie) |

Priorytet źródeł: `hook` (M9, wtyczka Bridge) > `claude-registry` > `osc-progress` > `bell` > `output-heuristic`. Źródło niższego priorytetu nie nadpisuje stanu z wyższego przez 10 s od ostatniej aktualizacji wyższego.

### 9.5 Publikacja

`AgentService` emituje `agents:updated` (lista agentów z `terminalId`, `projectId`) i aktualizuje `TerminalInfo`. Wtyczki dostają to przez `oxy.agents` ([07 §6](07-plugin-engine.md)).

## 10. Zakończenie, restart, zabijanie

- **Proces powłoki kończy się** → `exit` → panel pokazuje pod ostatnią linią pasek: „Process exited with code 0” + „Restart” / „Close” (ustawienie `terminal.closeOnExit: 'never' | 'ifClean' | 'always'`, domyślnie `ifClean` → zamknięcie panelu przy kodzie 0 po 1 s, chyba że terminal był agentem).
- **Zamknięcie panelu**: jeśli `kind !== 'shell'` (działa proces/agent) i `terminal.confirmOnKill = 'whenProcessRunning'` (domyślnie) → potwierdzenie „Claude Code is running in this terminal. Terminate it?”.
- **Kill**: `pty.kill()`; po 3 s, jeśli proces żyje → `tree-kill(pid, 'SIGKILL')` (Windows: `taskkill /T /F`). Po wyjściu headless zostaje do `dispose` panelu (by można było przeczytać ostatni output).
- **Restart**: kill + nowy spawn z tym samym `TerminalId`? — **Nie**: nowy `TerminalId`, ten sam panel (deskryptor aktualizowany); stary bufor zachowany nad separatorem `── Restarted ──`.

## 11. Shell integration (M7)

Cel: znać granice komend, cwd, kody wyjścia bez zgadywania.

- Skrypty w `resources/shell-integration/` wzorowane na skryptach VS Code (licencja MIT — zachować nagłówek licencji i atrybucję): `pwsh.ps1`, `bash.sh`, `zsh/.zshrc` (+ `.zshenv`, `.zprofile`, `.zlogin` przekierowujące do oryginałów), `fish.fish`.
- Wstrzykiwanie (tylko gdy `terminal.shellIntegration` = true, domyślnie true od M7):
  - pwsh/powershell: argumenty `-NoLogo -NoExit -Command ". '<path>\pwsh.ps1'"`;
  - bash: `--init-file <path>/bash.sh` (skrypt najpierw sourcuje `~/.bashrc`/login files);
  - zsh: `ZDOTDIR=<tmp dir z naszymi plikami>` + `USER_ZDOTDIR` do oryginału;
  - fish: `XDG_DATA_DIRS` z katalogiem `vendor_conf.d`;
  - cmd, Git Bash (poza bash), WSL: brak w M7.
- Emitowane sekwencje `OSC 633`: `A` (start promptu), `B` (koniec promptu), `C` (start wykonania), `D;<exit>` (koniec), `E;<commandline>` (treść komendy, escapowana), `P;Cwd=<path>`.
- PTY Host parsuje je w headless → zdarzenia `terminal:command` `{ phase, commandLine?, exitCode?, cwd?, durationMs? }`.
- Wykorzystanie: dokładne `kind = 'process'` (komenda w trakcie), aktualny cwd (split w tym samym katalogu, linki), powiadomienie o zakończeniu komendy trwającej > 30 s w niewidocznym terminalu, wysyłanie `initialCommand` dopiero po `B`.

## 12. Wydajność i pamięć

- Pamięć bufora: ~12 B/komórkę → 120 kol × 5000 linii ≈ 7 MB na kopię; każdy terminal ma 2 kopie (headless + renderer, jeśli zamontowany). 10 terminali ≈ 140 MB w najgorszym wypadku — akceptowalne; stąd domyślny scrollback 5000 (konfigurowalny 1000–100 000).
- Budżety: echo klawisza < 30 ms (p95), `cat` pliku 50 MB nie blokuje UI (reakcja na klik < 100 ms w trakcie), throughput ≥ 10 MB/s bez utraty danych.
- Test obciążeniowy w CI (integration): skrypt Node generujący 20 MB danych z sekwencjami kolorów; weryfikacja sumy kontrolnej zawartości headless vs oczekiwana i braku zawieszeń (flow control).

## 13. Testy

- **Unit (Vitest, Node):** `FlowController` (progi, timeout), `DataBatcher` (czas/rozmiar), `env-composer` (kolejność, `null`, case-insensitive na Windows, czyszczenie markerów), wykrywanie profili (z mockiem FS/rejestru), reguły agentów (drzewa procesów z fixture), mapowanie statusów rejestru Claude, parsery OSC.
- **Integration (Vitest, prawdziwy node-pty w Node — prebuild N-API działa w Node i Electron):** spawn `node -e` → output; resize; exit code; snapshot → nowy headless ↔ identyczna zawartość; 20 MB output z pauzą/wznowieniem.
- **E2E (Playwright + Electron):** otwarcie terminala, `echo`, kolory ANSI (sprawdzenie klasy/stylu w DOM renderer), Ctrl+C przerywa `ping -t`/`sleep`, kopiuj/wklej, split, zamknięcie z potwierdzeniem, fikcyjny agent (skrypt `tests/fixtures/bin/claude(.cmd)` + zapis pliku rejestru) → badge „AI AGENT” i kropka `agent-working`/`attention`.

## 14. Kryteria akceptacji

- [ ] (M1) Profile wykryte na Windows (pwsh/PowerShell/cmd/Git Bash/WSL jeśli zainstalowane); terminal startuje < 500 ms; kolory 256/truecolor; Unicode (emoji, polskie znaki) poprawne.
- [ ] (M1) Ctrl+C przerywa proces; Ctrl+C z zaznaczeniem kopiuje; Ctrl+V wkleja; Shift+Enter w Claude Code wstawia nową linię.
- [ ] (M1) 20 MB outputu nie zawiesza UI, nie gubi danych (porównanie headless).
- [ ] (M1) Reload renderera (Ctrl+R w dev) → terminale wracają z pełnym buforem, procesy żyją.
- [ ] (M3) Agent Claude Code wykrywany w < 3 s od startu; stan `working`/`idle` zgodny z rejestrem; `waiting` sygnalizowany powiadomieniem.
- [ ] (M3) Zamknięcie aplikacji z działającym agentem wymaga potwierdzenia; po potwierdzeniu brak osieroconych procesów (sprawdzenie listy procesów w E2E).
- [ ] (M7) Shell integration: cwd i granice komend w pwsh i bash; powiadomienie o zakończeniu długiej komendy.
