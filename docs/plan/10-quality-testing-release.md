# 10 — Jakość, testy, CI i wydawanie

## 1. Strategia testów

| Poziom | Narzędzie | Środowisko | Co obejmuje | Kiedy uruchamiane |
|---|---|---|---|---|
| Unit | Vitest 5 | Node (`environment: 'node'`) | `shared/*`, logika serwisów main (z mockami FS/IPC), parsery (porcelain, numstat, OSC, JSONL), flow control, env composer, reguły agentów, pricing, migracje | każdy commit (`npm test`) |
| Component | Vitest + Testing Library | jsdom | komponenty UI bez xterm/Monaco (Tree, ProjectItem, StatusDot, ChangesHeader, SettingsForm), store'y Zustand | każdy commit |
| Integration | Vitest | Node + prawdziwe zależności | PTY Host z prawdziwym node-pty (prebuild N-API działa też w Node), Workspace Host z prawdziwym git w katalogach tymczasowych, Plugin Host z wtyczkami testowymi, worker Usage Monitora z `node:sqlite` | każdy commit (projekt `integration`, dłuższy timeout) |
| E2E | Playwright 1.63 `_electron.launch()` | zbudowana aplikacja (dev build `out/`) | scenariusze użytkownika (§4) | każdy PR (Windows + Linux), nightly (macOS) |
| Packaged smoke | Playwright z `executablePath` | zainstalowany/rozpakowany build electron-builder | start, terminal, git, wtyczki ładują się z `resources/` | przed wydaniem, CI na tagu |

**Konfiguracja Vitest** (`vitest.config.ts`): `projects` → `unit-node` (`src/{shared,main,pty-host,workspace-host,plugin-host}/**/*.test.ts`, `plugins/*/src/host/**/*.test.ts`), `unit-web` (`src/renderer/**/*.test.tsx`, `plugins/*/src/views/**/*.test.tsx`, jsdom), `integration` (`tests/integration/**/*.test.ts`, `testTimeout: 30000`, `pool: 'forks'`). Pokrycie (`@vitest/coverage-v8`): progi 80% linii dla `shared/`, parserów i serwisów domenowych; bez progów dla UI.

## 2. Zakres testów per moduł (skrót — szczegóły w dokumentach domenowych)

| Moduł | Kluczowe przypadki | Dokument |
|---|---|---|
| IPC/RPC | walidacja zod odrzuca złe payloady; `assertTrustedSender`; timeouty RPC; restart hosta anuluje oczekujące żądania z błędem | [01](01-architecture.md) |
| Projekty | dedupe (wielkość liter Windows), zagnieżdżenia, brak folderu, migracje `projects.json` | [03](03-projects-workspace.md) |
| Terminale | env composer, flow control, batcher, snapshot ↔ headless, profile, reguły agentów, rejestr Claude, OSC | [04](04-terminals.md) |
| Układ | serializacja/odtworzenie, `missing` panel, preview tabs | [05](05-layout-center.md) |
| Git | porcelain v2, numstat, statusVsHead, drzewo, scheduler, CRLF, pathspec, index.lock | [06](06-git-changes.md) |
| Wtyczki | manifest, uprawnienia, protokół (path traversal), env collection, crash/hang hosta | [07](07-plugin-engine.md) |
| Usage | parsery 3 źródeł, dedupe, koszty (złote wartości), atrybucja, bloki 5h, budżety, OTLP | [08](08-usage-monitor.md) |
| Ustawienia | JSONC z komentarzami (modify zachowuje komentarze), niepoprawne wartości → defaulty, atomowy zapis | [09](09-persistence-settings.md) |

## 3. Uprząż testowa i fixtures

### 3.1 Uruchamianie aplikacji w E2E

```ts
// tests/e2e/helpers/launch.ts (szkic)
export async function launchApp(opts: { userData?: string; env?: Record<string, string>; args?: string[] } = {}) {
  const userData = opts.userData ?? await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, ...(opts.args ?? [])],
    env: {
      ...process.env,
      OXYTOCIN_E2E: '1',                 // wyłącza animacje, auto-update, pobieranie cennika, powiadomienia OS (zamiast nich log)
      CLAUDE_CONFIG_DIR: fixturePath('claude/home'),
      CODEX_HOME: fixturePath('codex/home'),
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="app-ready"]');
  return { app, win, userData };
}
```
- Selektory przez `data-testid` (konwencja: `projects-item-<name>`, `terminal-panel-<id>`, `changes-row-<path>`, `status-dot-<projectId>`, `usage-today`).
- Odczyt treści terminala w E2E: hak testowy dostępny tylko przy `OXYTOCIN_E2E=1` — `window.__oxyTest.getTerminalText(terminalId)` (czyta bufor xterm), aby nie polegać na DOM renderera.
- Tryb `OXYTOCIN_E2E=1` nigdy nie włącza się w buildach produkcyjnych bez zmiennej (sprawdzane w kodzie).

### 3.2 Repozytoria git testowe

`tests/helpers/git-repo.ts`: `createRepo({ files, commits, autocrlf?, initialCommit? })` w katalogu tymczasowym, z lokalnym `user.name/email`, `core.autocrlf` ustawianym jawnie (niezależność od konfiguracji maszyny CI), sprzątanie po teście.

### 3.3 Fikcyjni agenci

- `tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js` — skrypt Node udający Claude Code: zapisuje `${CLAUDE_CONFIG_DIR}/sessions/<pid>.json` ze statusami (`busy` → `waiting` → `idle` sterowane wejściem stdin), emituje `OSC 9;4;3` podczas „pracy”, dopisuje linie `assistant` z `usage` do `projects/<enc>/<session>.jsonl`, reaguje na Ctrl+C. Uruchamiany jako `node <ścieżka>/cli.js` — linia poleceń pasuje do reguły `@anthropic-ai/claude-code` (na Windows nazwa procesu to `node.exe`, więc reguła po nazwie nie zadziała — test weryfikuje regułę po linii poleceń).
- Analogicznie `@openai/codex/bin/codex.js` (rollout z `token_count`) i `@google/gemini-cli` (chat JSONL).
- Skrypty dostępne w PATH terminala testowego przez profil testowy lub `terminal.env` w ustawieniach E2E.

### 3.4 Fixtures logów

`tests/fixtures/{claude,codex,gemini}/` — zanonimizowane (skrypt `scripts/make-fixtures.ts`, [08 §18](08-usage-monitor.md)), z plikiem `expected.json` (oczekiwane sumy tokenów i kosztów) używanym przez testy unit, integration i E2E. Daty w fixture'ach względne (`"timestamp": "{{now-5m}}"`) — podstawiane przy kopiowaniu do katalogu tymczasowego.

## 4. Scenariusze E2E (minimum dla MVP)

1. **Start i onboarding:** pusta instalacja → ekran powitalny → dodanie projektu (przez IPC testowe symulujące dialog lub argv) → terminal startuje, prompt widoczny < 1,5 s od startu.
2. **Terminal podstawy:** `echo` → tekst w buforze; kolorowy output (`node -e "console.log('\x1b[31mred\x1b[0m')"`) → atrybut koloru w buforze; Ctrl+C przerywa długi proces; kopiuj/wklej.
3. **Split i DnD:** podział w prawo i w dół → 3 terminale; przeciągnięcie panelu do innej grupy → bufor i proces nienaruszone.
4. **Przełączanie projektów:** licznik w A, przełączenie na B na 10 s, powrót → brak luk w liczniku; kropka `running` przy A widoczna z B.
5. **LRU i rehydratacja:** `keepAliveProjects=1`, dwa projekty naprzemiennie → bufor odtworzony, kolory zachowane.
6. **Restart aplikacji:** układ, projekty, scrollback z separatorem „Session restored”.
7. **Zmiany git:** nowy plik → `U` < 1 s; modyfikacja → `M` z licznikami; diff otwarty z poprawną treścią; commit w terminalu → pusta lista.
8. **Agent (fikcyjny Claude):** start → badge „AI AGENT”, kropka `agent-working`; przejście w `waiting` → kropka `attention` + toast (projekt nieaktywny); kropka wraca do `idle`.
9. **Wtyczki:** Markdown Preview z menu drzewa Zmian, live reload; wtyczka testowa „crash” → placeholder błędu, reszta działa; CSP blokuje `fetch` z widoku.
10. **Usage:** fixture'y → koszt „today” zgodny z `expected.json`; dopisanie linii → aktualizacja < 2 s; dashboard otwiera się; budżet 80% → toast.
11. **Zamknięcie z procesami:** dialog potwierdzenia; po potwierdzeniu brak procesów potomnych (lista procesów systemu).

Artefakty przy porażce: Playwright trace, zrzut ekranu, `userData/logs/main.log`.

## 5. Budżety wydajności (skonsolidowane)

| Metryka | Cel | Próg CI (tolerancja) | Pomiar |
|---|---|---|---|
| Start → pierwszy prompt terminala | < 1,5 s | < 3 s (Windows CI: < 4 s — zimny start PowerShell na runnerach) | `performance.mark('app-start')` w main (czas procesu) + `mark('terminal-first-output')` |
| Przełączenie projektu (zamontowany) | < 100 ms | < 150 ms | mark przed `setActive` → po `requestAnimationFrame` z widocznym terminalem |
| Rehydratacja 5 terminali × 5000 linii | < 400 ms | < 800 ms | jw. |
| Echo klawisza (p95) | < 30 ms | — (ręcznie/benchmark) | benchmark lokalny |
| Throughput terminala | ≥ 10 MB/s bez utraty | 20 MB w < 10 s | test integracyjny |
| Zapis pliku → „na żywo” w Zmianach | < 300 ms | < 800 ms | E2E |
| Zapis pliku → status i liczniki | < 1 s | < 2 s | E2E |
| Zdarzenie usage → UI | < 2 s | < 4 s | E2E |
| RAM (3 projekty × 3 terminale, bez wtyczek zewn.) | < 450 MB łącznie | raport | `app.getAppMetrics()` w teście nightly |

Wyniki pomiarów E2E zapisywane do `perf-results.json` (artefakt CI) — trend porównywany ręcznie przed wydaniem.

## 6. Analiza statyczna

- `npm run typecheck` → `tsc -b` dla `tsconfig.node.json`, `tsconfig.web.json`, pakietów i wtyczek.
- ESLint (flat config): `typescript-eslint` `recommendedTypeChecked`, `@typescript-eslint/no-floating-promises` (error), `no-misused-promises`, `consistent-type-imports`, `react-hooks/rules-of-hooks` + `exhaustive-deps`, `no-restricted-imports` egzekwujące granice katalogów ([01 §3](01-architecture.md)), zakaz `console.*` poza skryptami (używaj loggera), zakaz literałów kolorów w TSX (reguła `no-restricted-syntax` na wzorce `#[0-9a-f]{3,8}` w JSX style — pragmatycznie).
- Prettier 3 (printWidth 120, singleQuote, trailingComma all).
- `npm run check` = typecheck + lint + test (używane przez sesje implementacyjne przed commitem).

## 7. CI (GitHub Actions)

`.github/workflows/ci.yml`:
```yaml
on: [push, pull_request]
jobs:
  check:
    strategy: { matrix: { os: [windows-latest, ubuntu-latest, macos-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci                      # Linux: node-pty 1.1.0 kompiluje się (runner ma build-essential/python3)
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run licenses:check   # tylko licencje zgodne z MIT (ADR-020); wystarczy na jednym OS
      - run: npm test -- --project unit-node --project unit-web
      - run: npm test -- --project integration
  e2e:
    needs: check
    strategy: { matrix: { os: [windows-latest, ubuntu-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - (checkout, setup-node, npm ci)
      - run: npm run build
      - run: npx playwright install --with-deps   # tylko zależności systemowe; Electron z node_modules
      - run: npm run e2e                           # ubuntu: xvfb-run -a npm run e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: e2e-${{ matrix.os }}, path: [test-results/, playwright-report/] }
```
`.github/workflows/release.yml` (tag `v*`): build `electron-builder --win --publish never` / `--mac` / `--linux` na odpowiednich runnerach → packaged smoke → upload do draft GitHub Release. (Repozytorium zdalne — decyzja właściciela; do tego czasu CI może pozostać lokalnie przygotowane.)

## 8. Pakowanie

- electron-builder wg szkicu w [01 §11](01-architecture.md). `npmRebuild: false` — polegamy na prebuildach (Windows/macOS). Linux: w CI moduły kompilowane przy `npm ci` pod Node, **ale** muszą pasować do ABI Electrona — node-pty i @parcel/watcher używają N-API (ABI-stabilne), więc build pod Node działa w Electron; zweryfikować w S1 (jeśli nie — `@electron/rebuild` w kroku Linux).
- `asarUnpack` dla modułów natywnych (pliki `.node`, `conpty.dll`, `OpenConsole.exe`, `spawn-helper` na macOS — **musi mieć prawo wykonywania**; znany problem prebuildów: dodać krok `chmod +x` w `afterPack` dla macOS).
- Wtyczki wbudowane jako `extraResources` (poza asar, aby protokół `oxy-plugin://` serwował pliki zwykłym `net.fetch(file://)`); integralność: przy starcie w buildzie produkcyjnym porównanie sum SHA-256 plików wtyczek wbudowanych z manifestem generowanym w buildzie (ochrona przed przypadkową modyfikacją).
- Fuses w `afterPack` (lista w [01 §5](01-architecture.md)).
- Ikony: `resources/build/icon.ico` (256×256 wielowarstwowa), `icon.icns`, `icon.png` (512).
- Rozmiar docelowy instalatora Windows: < 120 MB.
- **Licencje (ADR-020):** `LICENSE` (MIT) i `THIRD_PARTY_NOTICES.md` (generowany `npm run licenses:notices` przed każdym buildem produkcyjnym) trafiają do `resources/` paczki; okno „About” pokazuje wersję i licencję MIT, menu „Help → Third-Party Notices” otwiera plik z atrybucjami. Instalator NSIS bez strony akceptacji licencji (MIT tego nie wymaga).

## 9. Podpisywanie i aktualizacje (M9)

- **Windows:** Azure Trusted Signing lub certyfikat OV/EV (electron-builder `win.signtoolOptions` / `azureSignOptions`); bez podpisu SmartScreen ostrzega — akceptowalne dla wersji 0.x używanych prywatnie.
- **macOS:** Developer ID Application + hardened runtime + notarization (`notarize: true`), entitlements: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` (jeśli wymagane przez moduły natywne).
- **Auto-update:** `electron-updater` (provider GitHub), kanały `latest`/`beta`, sprawdzanie przy starcie i co 6 h, pobieranie w tle, instalacja **przy następnym uruchomieniu** lub po kliknięciu „Restart” (nigdy automatyczny restart — terminale z agentami!). Przed restartem aktualizacji — ten sam `QuitGuard` co przy zamykaniu.

## 10. Wersjonowanie i historia zmian

- Język: `CHANGELOG.md`, opisy wydań, commity i README po angielsku (ADR-018).

- SemVer, linia `0.x` do stabilizacji API wtyczek. Wersja aplikacji w `package.json`; `OXYTOCIN_API_VERSION` niezależnie ([07 §12](07-plugin-engine.md)).
- Commity w stylu Conventional Commits (`feat(terminals): …`, `fix(git): …`) — ułatwia `CHANGELOG.md` (ręcznie lub `release-please` później).

## 11. Checklista wydania

- [ ] `npm run check` + E2E zielone na Windows i Linux; nightly macOS zielony.
- [ ] `npm run pricing:update` wykonany (świeży snapshot cennika).
- [ ] Budżety wydajności z `perf-results.json` bez regresji > 20%.
- [ ] Packaged smoke na Windows (instalacja NSIS, start, terminal, git, wtyczki, odinstalowanie).
- [ ] Ręczny test z prawdziwym Claude Code (stan agenta, koszty, Shift+Enter, obrazy przez Ctrl+V).
- [ ] CHANGELOG, numer wersji, tag.
