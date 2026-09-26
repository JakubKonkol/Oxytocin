# 08 — Wtyczka wbudowana: Usage Monitor (Monitor Zużycia)

Wymaganie: **R-PLG-3** — śledzenie (na podstawie logów lub wstrzykniętych zmiennych środowiskowych) liczby zużytych tokenów i przeliczanie na koszt USD w czasie rzeczywistym dla aktywnych agentów (Claude, OpenAI, Gemini). Plugin zajmuje dolną lewą sekcję (zgodnie z prototypem: karta z paskiem „64% limitu tokenów”).

## 1. Cele i definicje

- **„Czas rzeczywisty”**: od zakończenia odpowiedzi modelu do aktualizacji UI **≤ 2 s** (źródła plikowe: fs.watch + tail; OTLP: interwał eksportu ustawiony na 2–5 s).
- **Koszt**: w USD; domyślnie **wyliczany z tokenów i cennika** (spójny dla wszystkich agentów); jeśli źródło raportuje koszt (starsze JSONL Claude `costUSD`, metryka OTEL `claude_code.cost.usage`) — tryb `auto` go używa. Użytkownicy subskrypcji (Claude Pro/Max, ChatGPT Plus/Pro) widzą **„API-equivalent cost”** (ustawienie `usage.billing.*`), bo realnie nie płacą per token.
- **Zakres**: agenci CLI uruchamiani w terminalach Oxytocin **oraz** poza nim (logi są globalne) — przypisanie do projektu po `cwd`, do terminala tylko gdy jest to możliwe.
- **Plugin „dogfoodingowy”**: używa wyłącznie publicznego API ([07](07-plugin-engine.md)). Brakujące API dodajemy do rdzenia, a nie obchodzimy.

## 2. Architektura wtyczki

```
plugins/usage-monitor/
├─ package.json (manifest: views usage.sidebar [sidebar, order 300], panels usage.dashboard, statusBarItems usage.today,
│                commands, configuration prefix "usage", permissions: projects.read, agents.read, agents.annotate,
│                terminals.read-metadata, terminals.env, fs.read-home, net.listen-local, net.fetch, notifications.os)
├─ src/host/
│  ├─ index.ts                 # activate(): uruchamia IngestWorker, rejestruje providery widoków, polecenia, status bar, env
│  ├─ ingest-worker.ts         # worker_thread: collectory + SQLite (node:sqlite) + agregacje — nie blokuje wspólnego Plugin Host
│  ├─ collectors/
│  │  ├─ claude-jsonl.ts
│  │  ├─ codex-rollout.ts
│  │  ├─ gemini-chats.ts
│  │  ├─ otlp-receiver.ts      # opt-in
│  │  └─ tail.ts               # wspólny tailer plików JSONL (kursory, obcięcia, niepełne linie)
│  ├─ pricing/
│  │  ├─ snapshot.json         # generowany przez scripts/update-pricing.ts
│  │  ├─ pricing-service.ts    # snapshot + cache z odświeżania + nadpisania użytkownika
│  │  ├─ normalize-model.ts
│  │  └─ cost.ts               # formuły per dostawca
│  ├─ store/
│  │  ├─ db.ts                 # otwarcie, PRAGMA, migracje
│  │  ├─ migrations/001_init.sql …
│  │  └─ queries.ts            # agregacje
│  ├─ attribution.ts           # cwd → projekt, sesja → terminal (oxy.agents)
│  ├─ budgets.ts               # budżety, bloki 5h, progi, powiadomienia
│  └─ live.ts                  # sesje na żywo, burn rate, projekcje
└─ src/views/
   ├─ sidebar/ (React + @oxytocin/plugin-sdk)
   └─ dashboard/ (React + uPlot)
```

- **Worker thread** (`node:worker_threads` wewnątrz Plugin Host): parsowanie JSONL i zapytania `DatabaseSync` są synchroniczne i mogą trwać — worker chroni pętlę zdarzeń hosta współdzieloną z innymi wtyczkami. Komunikacja wątek główny wtyczki ⇄ worker przez `postMessage` (komendy i zdarzenia `summaryChanged`).
- Backend publikuje do widoków zdarzenie `usage:update` (throttle 1 s) z gotowym „modelem widoku” (sumy, sesje na żywo, budżety) — widoki są „głupie”.

## 3. Macierz źródeł danych

| Agent | Źródło | Domyślnie | Dokładność tokenów | Opóźnienie | Przypisanie do projektu | Przypisanie do terminala |
|---|---|---|---|---|---|---|
| Claude Code | **JSONL transcripts** `~/.claude/projects/**/*.jsonl` | **włączone** | wysoka (usage per wiadomość, cache 5m/1h, speed, tier) | ~0,5–1 s | `cwd` z każdej linii | `sessionId` ↔ rejestr sesji (pid) ↔ drzewo procesów terminala (przez `oxy.agents`) |
| Claude Code | OTLP (metryki `claude_code.token.usage`, `claude_code.cost.usage`) | wyłączone (opt-in) | wysoka, koszt raportowany przez CLI | 2–5 s (ustawiamy interwał) | przez atrybuty zasobu `oxytocin.project_id` | `oxytocin.terminal_id` w `OTEL_RESOURCE_ATTRIBUTES` |
| Codex CLI | **Rollouts** `~/.codex/sessions/**/rollout-*.jsonl` | **włączone** | wysoka (sumy skumulowane + delty, cached, reasoning) + **rate_limits** jeśli obecne | ~1 s | `cwd` z `session_meta`/`turn_context` | korelacja czasowa (start procesu `codex` w terminalu ↔ utworzenie pliku rollout w tym samym cwd) |
| Gemini CLI | **Chats** `~/.gemini/tmp/<projectHash>/chats/*.jsonl` (≥0.60) i `*.json` (starsze) | **włączone** | wysoka (input/output/cached/thoughts/tool) | ~1 s | `projectHash` = hash ścieżki projektu (weryfikacja w S7) | korelacja czasowa jak Codex |
| Gemini CLI | OTLP (`gemini_cli.api_response`, `gemini_cli.token.usage`) | wyłączone (opt-in) | wysoka | 2–5 s | atrybuty / cwd | `OTEL_RESOURCE_ATTRIBUTES` (jeśli respektowane — S7) |
| Inni (Aider…) | Parser outputu terminala (`Tokens: 12k sent, 1.2k received. Cost: $0.05`) | backlog | średnia | natychmiast | terminal → projekt | bezpośrednie |

**Odrzucone:** lokalny proxy HTTP podstawiany przez `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` (ingerencja w uwierzytelnianie OAuth subskrypcji, TLS, streaming; ryzyko awarii agenta) — ADR-011.

## 4. Znormalizowany model zdarzenia

```ts
export interface UsageEvent {
  id: string;                 // klucz deduplikacji, np. "claude:msg_01…:req_01…", "codex:<sessionId>:<totalTokens>", "gemini:<sessionId>:<messageId>"
  ts: number;                 // epoch ms (czas odpowiedzi)
  agent: 'claude-code' | 'codex' | 'gemini-cli' | string;
  provider: 'anthropic' | 'openai' | 'google' | string;
  model: string;              // znormalizowany (normalize-model.ts), oryginał w rawModel
  rawModel: string;
  sessionId?: string;
  projectId?: string;         // przypisany projekt Oxytocin (może być null — spoza projektów)
  cwd?: string;
  terminalId?: string;
  isSubagent?: boolean;       // Claude isSidechain / subagent file
  tokens: {
    input: number;            // NIEcache'owane wejście (po normalizacji semantyki dostawcy)
    output: number;           // całe wyjście rozliczane jako output (łącznie z reasoning/thinking)
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    reasoning: number;        // informacyjnie (część output)
  };
  extras?: { webSearchRequests?: number; speed?: 'standard' | 'fast'; serviceTier?: string; inferenceGeo?: string };
  costUsd: number | null;     // null = nieznany model
  costSource: 'computed' | 'reported';
  pricingVersion?: string;
  source: 'claude-jsonl' | 'claude-otel' | 'codex-rollout' | 'gemini-chat' | 'gemini-otel' | 'output-parser';
}
```

## 5. Collector: Claude Code JSONL

### 5.1 Lokalizacje

Katalogi bazowe (wszystkie istniejące, bez duplikatów po `realpath`): wartości z `CLAUDE_CONFIG_DIR` (rozdzielane przecinkiem), `~/.claude`, `~/.config/claude` (XDG na Linux). Pliki: `<base>/projects/**/*.jsonl` **rekurencyjnie** (zawiera transkrypty subagentów w podkatalogach sesji, jeśli wersja CLI je tam zapisuje). Pomijaj pliki > 1 GB (log ostrzeżenia).

### 5.2 Tailer (`tail.ts`, wspólny dla źródeł JSONL)

- Kursor per plik w tabeli `ingest_cursors`: `{ path, fileId (ino/dev lub na Windows ino z fs.stat — dostępne w Node), size, mtimeMs, offset }`.
- Zdarzenia: `fs.watch(base/projects, { recursive: true })` (Windows/macOS natywnie; Linux — Node 24 wspiera recursive) + **przegląd okresowy co 30 s** (odporność), + przegląd przy starcie.
- Odczyt od `offset` do EOF strumieniowo (`fs.createReadStream({ start })` + dzielenie po `\n`); ostatnia niepełna linia (bez `\n`) **nie jest** przetwarzana — `offset` wskazuje jej początek.
- `size < offset` lub zmiana `fileId` → plik obcięty/podmieniony → czytaj od 0 (deduplikacja zapobiega podwójnemu liczeniu).
- **Backfill** przy pierwszym uruchomieniu: pliki z `mtime` w ostatnich `usage.backfillDays` (domyślnie 30), od najnowszych; postęp w UI („Indexing history… 45%”).
- Szybka ścieżka: linia bez podciągu `"usage"` jest pomijana **bez** `JSON.parse` (większość linii to treść narzędzi/wiadomości).

### 5.3 Parsowanie linii

Linia jest brana pod uwagę, gdy: `type === "assistant"` i istnieje `message.usage`. Pomijane: `message.model === "<synthetic>"` (komunikaty błędów generowane lokalnie).

| Pole zdarzenia | Źródło w linii |
|---|---|
| `id` | `"claude:" + message.id + ":" + (requestId ?? "")`; brak `message.id` → `"claude:uuid:" + uuid` |
| `ts` | `Date.parse(timestamp)` |
| `sessionId` / `cwd` | `sessionId` / `cwd` |
| `isSubagent` | `isSidechain === true` lub plik w podkatalogu `subagents/` |
| `rawModel` | `message.model` |
| `tokens.input` | `usage.input_tokens` |
| `tokens.cacheRead` | `usage.cache_read_input_tokens` |
| `tokens.cacheWrite5m` / `cacheWrite1h` | `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`; gdy brak obiektu `cache_creation` → całość `cache_creation_input_tokens` jako 5m |
| `tokens.output` | `usage.output_tokens` |
| `tokens.reasoning` | `usage.output_tokens_details.thinking_tokens` (informacyjnie) |
| `extras.speed` / `serviceTier` / `inferenceGeo` | `usage.speed` / `usage.service_tier` / `usage.inference_geo` |
| `extras.webSearchRequests` | `usage.server_tool_use.web_search_requests` |
| koszt raportowany | pole `costUSD` (starsze wersje), jeśli obecne |

**Deduplikacja i monotoniczność:** jedna odpowiedź API zapisywana jest jako 2–10 linii z tym samym `message.id` (po jednej na blok: thinking, text, tool_use). Upsert po `id` z **maksimum** każdego pola tokenów (`ON CONFLICT(id) DO UPDATE SET output = max(output, excluded.output), …`) i ponownym przeliczeniem kosztu. Chroni to też przed historycznym błędem placeholderów `output_tokens` (issues #22686, #25941).
Pole `usage.iterations[]` (widoczne w 2.1.283) — tylko informacyjnie; sumy bierzemy z pól najwyższego poziomu (zweryfikować w spike S6, czy nie trzeba sumować iteracji).

### 5.4 Weryfikacja dokładności (spike S6, początek M6)

Uruchomić Claude Code z OTEL `console`/lokalnym odbiornikiem na 10 promptach (z narzędziami, subagentem, web search) i porównać: suma tokenów per typ z JSONL (po deduplikacji) vs `claude_code.token.usage`; koszt wyliczony vs `claude_code.cost.usage`. Akceptowalna różnica: tokeny 0%, koszt < 1%. Wynik → `docs/spikes/S6-claude-usage-accuracy.md`; w razie rozbieżności poprawić parser lub zmienić domyślne źródło (ADR).

## 6. Przypisanie: projekt i terminal (`attribution.ts`)

- **Projekt:** `oxy.projects.findByPath(cwd)` (najdłuższy prefiks; Windows/macOS bez rozróżniania wielkości liter). Cache wyników per `cwd`. Przeliczenie `project_id` dla zdarzeń przy dodaniu/usunięciu/przeniesieniu projektu (UPDATE po `cwd` LIKE prefiks).
- **Terminal — Claude:** `oxy.agents.onDidChange` dostarcza `AgentSnapshot { terminalId, agentId: 'claude-code', sessionId }` (rdzeń zna `sessionId` z rejestru `~/.claude/sessions/<pid>.json`). Tabela `sessions` zapamiętuje `terminal_id` dla `session_id`; zdarzenia sesji dostają `terminal_id` przy zapisie (i wstecznie: UPDATE zdarzeń sesji bez terminala z ostatnich 24 h).
- **Terminal — Codex/Gemini:** gdy `oxy.agents` zgłasza nowego agenta `codex`/`gemini-cli` w terminalu T (czas `since`, `cwd` projektu), a w ciągu 60 s pojawia się **nowy** plik sesji tego agenta z tym samym `cwd` (Gemini: `projectHash`) → powiązanie `sessionId ↔ T` + `oxy.agents.reportSession(T, { sessionId, source: 'usage-monitor' })`. Niejednoznaczność (dwa agenty tego samego typu wystartowały w tym samym projekcie w oknie 60 s) → brak przypisania terminala (projekt nadal znany).

## 7. Collector: Codex CLI

- Katalogi: `${CODEX_HOME ?? ~/.codex}/sessions/**/rollout-*.jsonl` oraz `archived_sessions/**` (jeśli ta sama ścieżka względna istnieje w obu — wygrywa `sessions/`).
- Linie `{ timestamp, type, payload }`:
  - `session_meta` → `payload.id` (sessionId), `payload.cwd`, wersja CLI;
  - `turn_context` → `payload.model` (model dla kolejnych zdarzeń), `payload.cwd`;
  - `event_msg` z `payload.type === 'token_count'` → `payload.info?.total_token_usage` (skumulowane dla sesji), `payload.info?.last_token_usage`, `payload.rate_limits?` (jeśli obecne: `primary`/`secondary` z `used_percent`, `window_minutes`, `resets_at`/`resets_in_seconds`).
- **Deduplikacja przez delty sum:** zdarzenia `token_count` bywają emitowane podwójnie. Dla sesji pamiętamy ostatnie `total_token_usage`; nowe zdarzenie z `total_tokens` większym → **delta = total − poprzedni total** (per pole) → `UsageEvent` z `id = "codex:<sessionId>:<total_tokens>"`. Równe → pomiń. Mniejsze (reset/kompakcja) → przyjmij `last_token_usage` jako deltę i zresetuj bazę.
- Semantyka OpenAI: `input_tokens` **zawiera** `cached_input_tokens` → `tokens.input = input − cached`, `tokens.cacheRead = cached`; `output_tokens` **zawiera** `reasoning_output_tokens` → `tokens.output = output`, `tokens.reasoning = reasoning`.
- Tier usługi (`priority`/`flex`) — jeśli dostępny w logu (np. zdarzenie ustawień wątku) → stawki `*_priority` / `*_flex`.
- Brak `turn_context` z modelem przed pierwszym `token_count` → model `unknown` (koszt `null`, ostrzeżenie w „Sources”).
- **rate_limits** zapisywane w `agent_limits` (ostatnia wartość per agent) → pasek „% limitu” dla Codexa (realne dane, nie estymacja).

## 8. Collector: Gemini CLI

- Katalogi: `~/.gemini/tmp/<projectHash>/chats/` — pliki `*.jsonl` (≥ 0.60) oraz starsze `*.json`/`session-*.json` (pełne przepisywanie pliku → parsujemy całość przy zmianie `mtime`, deduplikacja po id wiadomości).
- JSONL: rekord `session_metadata` (sessionId, projectHash, czas startu), wiadomości `{ type: 'user' | 'gemini', id, … }`, rekordy `message_update` (aktualizacje tokenów/wyników narzędzi po `id`). Tokeny w wiadomości `gemini`: `tokens: { input, output, cached, thoughts, tool, total }`, `model`.
- Upsert po `id = "gemini:<sessionId>:<messageId>"` z najnowszymi wartościami (`message_update` nadpisuje).
- Semantyka Google: `input` (prompt) **zawiera** `cached` → `tokens.input = input − cached + tool` (tokeny promptu narzędzi rozliczane jak input — **zweryfikować w S7**), `tokens.cacheRead = cached`, `tokens.output = output + thoughts` (thinking rozliczany jako output), `tokens.reasoning = thoughts`.
- Przypisanie projektu: dla każdego projektu Oxytocin liczymy kandydackie hashe ścieżki (`sha256(rootPath)` w wariantach normalizacji: oryginalna wielkość liter, lowercase dysku na Windows) i porównujemy z `<projectHash>`; dopasowanie zapamiętane. **Spike S7** potwierdza algorytm `getProjectHash` w bieżącej wersji Gemini CLI.

## 9. Odbiornik OTLP (opt-in „Live telemetry”)

### 9.1 Kiedy i po co

Włączany ustawieniem per agent (`usage.liveTelemetry.claudeCode`, `usage.liveTelemetry.gemini`; domyślnie **off**). Korzyści: dokładne przypisanie do terminala (atrybuty zasobu), koszt raportowany przez samo CLI, niezależność od zmian formatu logów. Koszt: zmienne `OTEL_*` są **ogólne** — każdy program z SDK OpenTelemetry uruchomiony w takim terminalu (np. serwer dev z auto-instrumentacją) wyśle telemetrię do Oxytocin zamiast do własnego kolektora. Dlatego opt-in z jasnym opisem w UI.

### 9.2 Serwer

- `http.createServer` na `127.0.0.1`, port: ostatnio użyty (zapisany w storage wtyczki) lub losowy wolny; token Bearer (32 B, zapisany w storage).
- Endpointy: `POST /v1/metrics`, `POST /v1/logs` (przetwarzane), `POST /v1/traces` (200, ignorowane). Obsługa `Content-Encoding: gzip`. `Content-Type: application/json` (OTLP/JSON) — **wymagane dla Claude** (`http/json`); `application/x-protobuf` — dekodowanie przez `protobufjs` z dołączonymi definicjami opentelemetry-proto (potrzebne, jeśli Gemini `http` wysyła protobuf — S7). Brak/zły token → 401. Limit body 10 MB.

### 9.3 Wstrzykiwane zmienne (przez `oxy.terminals.environment`)

Claude Code:
```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
OTEL_METRIC_EXPORT_INTERVAL=5000
OTEL_LOGS_EXPORT_INTERVAL=2000
OTEL_RESOURCE_ATTRIBUTES=oxytocin.source=oxytocin      (per terminal rdzeń dokleja oxytocin.terminal_id i oxytocin.project_id — patrz niżej)
```
Gemini CLI:
```
GEMINI_TELEMETRY_ENABLED=true
GEMINI_TELEMETRY_TARGET=local
GEMINI_TELEMETRY_OTLP_ENDPOINT=http://127.0.0.1:<port>
GEMINI_TELEMETRY_OTLP_PROTOCOL=http
```
- **Atrybuty per terminal:** kolekcja env nie zna terminala w chwili rejestracji, więc wtyczka ustawia `OTEL_RESOURCE_ATTRIBUTES=oxytocin.source=oxytocin,oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID},oxytocin.project_id=${env:OXYTOCIN_PROJECT_ID}` — rdzeń rozwija podstawienia `${env:NAME}` przy składaniu env ([07 §8.7](07-plugin-engine.md), [04 §2.3](04-terminals.md)). Jeśli użytkownik ma własne `OTEL_RESOURCE_ATTRIBUTES`, wtyczka **dokleja** (append z separatorem `,`) zamiast zastępować.
- **Ochrona przed konfliktem:** jeśli w bazowym env użytkownika istnieje którakolwiek z `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `CLAUDE_CODE_ENABLE_TELEMETRY` → wtyczka **nie** wstrzykuje zmiennych Claude i pokazuje w „Sources”: „Your OpenTelemetry configuration was detected — live mode for Claude Code is off, using logs instead”.
- **Zakres:** ustawienie `usage.liveTelemetry.scope`: `'agentProfiles'` (domyślnie — tylko terminale uruchomione profilem agenta, np. „Claude Code”; realizowane przez `EnvScope.profileIds`, [07 §6.4](07-plugin-engine.md)) lub `'allTerminals'`.
- Uwaga: managed settings organizacji mogą nadpisać OTEL w Claude Code — wtedy dane przychodzą tylko z JSONL (stan w „Sources”: „No OTLP data for 10 min despite an active session”).

### 9.4 Mapowanie i relacja do JSONL

- Metryka `claude_code.token.usage` (suma, temporalność **delta**): punkty danych z atrybutami `type` (`input`/`output`/`cacheRead`/`cacheCreation`), `model`, `session.id` + atrybuty zasobu. `claude_code.cost.usage` (USD, `model`, `session.id`).
- **Zasada „jedno źródło na sesję”** (brak podwójnego liczenia): dla każdej sesji zapisujemy `primary_source`. Pierwsze zdarzenie z JSONL → `claude-jsonl`. Jeśli jako pierwsze przyjdą dane OTLP → czekamy 15 s na JSONL tej sesji; jeśli się pojawi — JSONL, inaczej `claude-otel` (dane OTLP zamieniane na `UsageEvent` z `id = "claude-otel:<session>:<ts>:<model>"`). Dane z nie-primary źródła **nie** trafiają do `usage_events`.
- Niezależnie od źródła tokenów OTLP zawsze aktualizuje: `sessions.terminal_id`/`project_id` (z atrybutów zasobu) oraz `sessions.reported_cost_usd` (suma `cost.usage`) — pokazywane w szczegółach sesji jako „Cost reported by Claude Code” obok wyliczonego (kontrola rozbieżności cennika).

## 10. Cennik (`pricing/`)

### 10.1 Snapshot (build-time)

`scripts/update-pricing.ts`:
1. Pobiera `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (~2,9 MB).
2. Filtruje: `litellm_provider ∈ {anthropic, openai, gemini, vertex_ai-language-models}`, `mode ∈ {chat, responses}`, klucze bez `/` (pomija duplikaty `bedrock/…`, `azure/…`).
3. Mapuje do zwartego formatu (stawki **za 1 token**):
```ts
interface ModelPrice {
  provider: 'anthropic' | 'openai' | 'google';
  input: number; output: number;
  cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number;           // cache_creation_input_token_cost / *_above_1hr
  above200k?: { input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number };
  priority?: { input?: number; output?: number; cacheRead?: number };        // *_priority (OpenAI/Gemini)
  flex?: { input?: number; output?: number; cacheRead?: number };
  fastMultiplier?: number;                                                    // provider_specific_entry.fast
  usMultiplier?: number;                                                      // provider_specific_entry.us (inference_geo=us)
  webSearchPerQuery?: number;                                                 // search_context_cost_per_query.search_context_size_medium
  maxInputTokens?: number;
}
```
4. Zapisuje `plugins/usage-monitor/src/pricing/snapshot.json` `{ version: '<data>-<sha8>', generatedAt, source, models: Record<string, ModelPrice> }` (~50–150 KB). Skrypt uruchamiany ręcznie (`npm run pricing:update`) i w CI przed release.

### 10.2 Runtime

- `usage.pricing.autoUpdate` (domyślnie true): raz na 24 h pobranie JSON (nagłówek `If-None-Match` z zapamiętanym ETag), transformacja jak wyżej, walidacja zod, zapis do `storage.globalDir/pricing-cache.json`. Błąd sieci → cicho, zostaje snapshot/cache.
- Kolejność: **nadpisania użytkownika** (`usage.pricing.overrides`, stawki w USD **za 1M tokenów** — przyjaźniej w edycji) > cache (jeśli nowszy niż snapshot) > snapshot.
- Zmiana wersji cennika → przeliczenie `cost_usd` zdarzeń z `cost_source='computed'` z ostatnich 90 dni (batch w transakcji w workerze), starsze zostają (stabilność historii).

### 10.3 Normalizacja nazw modeli

`lowercase` → usuń prefiksy `anthropic/`, `openai/`, `google/`, `models/` → usuń sufiksy kontekstu typu `[1m]` → dopasowanie: dokładne → bez sufiksu daty (`-\d{8}$`, `-\d{4}-\d{2}-\d{2}$`) → bez `-latest`/`-preview` → najdłuższy prefiks rodziny występującej w cenniku. Brak → model nieznany: `cost_usd = null`, UI pokazuje tokeny + „?” i baner „Unknown model ‘x’ — add its rates in Pricing”.

### 10.4 Formuły

```ts
function computeCost(e: UsageEvent, p: ModelPrice): number {
  const promptTotal = e.tokens.input + e.tokens.cacheRead + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h;
  const tier = p.above200k && promptTotal > 200_000 ? { ...p, ...p.above200k } : p;
  const rate = e.extras?.serviceTier === 'priority' && p.priority ? { ...tier, ...p.priority }
             : e.extras?.serviceTier === 'flex' && p.flex ? { ...tier, ...p.flex } : tier;
  let cost =
      e.tokens.input * rate.input
    + e.tokens.output * rate.output
    + e.tokens.cacheRead * (rate.cacheRead ?? rate.input)
    + e.tokens.cacheWrite5m * (rate.cacheWrite5m ?? rate.input)
    + e.tokens.cacheWrite1h * (rate.cacheWrite1h ?? rate.cacheWrite5m ?? rate.input);
  if (e.extras?.speed === 'fast' && p.fastMultiplier) cost *= p.fastMultiplier;
  if (e.extras?.inferenceGeo === 'us' && p.usMultiplier) cost *= p.usMultiplier;
  cost += (e.extras?.webSearchRequests ?? 0) * (p.webSearchPerQuery ?? 0);
  return cost;
}
```
Tryby (`usage.costMode`): `auto` (raportowany, jeśli źródło go podaje, inaczej wyliczony), `calculate` (zawsze wyliczony), `reported` (tylko raportowany; brak → null). Wyświetlanie: 2 miejsca po przecinku (`<$0.01` dla małych), 4 w tooltipach; prefiks `≈` dla wartości wyliczonych w trybie subskrypcji.

## 11. Magazyn danych (`node:sqlite`)

Plik: `userData/plugin-data/oxytocin.usage-monitor/usage.db`. `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`. Otwierany wyłącznie w workerze.

```sql
-- migrations/001_init.sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- schema_version, pricing_version

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  raw_model TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  cwd TEXT,
  terminal_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  speed TEXT, service_tier TEXT, inference_geo TEXT,
  cost_usd REAL,
  cost_source TEXT NOT NULL,
  pricing_version TEXT,
  source TEXT NOT NULL
);
CREATE INDEX ix_events_ts ON usage_events(ts);
CREATE INDEX ix_events_project_ts ON usage_events(project_id, ts);
CREATE INDEX ix_events_session ON usage_events(session_id);
CREATE INDEX ix_events_cwd ON usage_events(cwd);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  project_id TEXT, cwd TEXT, terminal_id TEXT,
  title TEXT,
  primary_source TEXT,
  first_event_at INTEGER, last_event_at INTEGER,
  last_model TEXT,
  reported_cost_usd REAL
);
CREATE INDEX ix_sessions_last ON sessions(last_event_at);

CREATE TABLE ingest_cursors (
  path TEXT PRIMARY KEY, source TEXT NOT NULL,
  file_id TEXT, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL,
  state TEXT,                                   -- JSON: np. ostatnie total_token_usage Codexa dla sesji
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_limits (                     -- realne limity raportowane przez agentów (np. Codex rate_limits)
  agent TEXT NOT NULL, window TEXT NOT NULL,    -- 'primary' | 'secondary' | ...
  used_percent REAL, window_minutes INTEGER, resets_at INTEGER, observed_at INTEGER NOT NULL,
  PRIMARY KEY (agent, window)
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,                          -- 'global' | 'project' | 'agent'
  scope_ref TEXT,                               -- project_id / agent id
  period TEXT NOT NULL,                         -- 'day' | 'week' | 'month' | 'block5h'
  metric TEXT NOT NULL,                         -- 'usd' | 'tokens'
  amount REAL NOT NULL,
  thresholds TEXT NOT NULL DEFAULT '[0.8,1.0]', -- JSON
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE budget_alerts (budget_id TEXT NOT NULL, period_key TEXT NOT NULL, threshold REAL NOT NULL, fired_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, period_key, threshold));
```

- Migracje: numerowane pliki SQL, `meta.schema_version`, wykonywane w transakcji przy otwarciu.
- Retencja: `usage.retentionDays` (domyślnie 400) — usuwanie starszych zdarzeń raz dziennie; `VACUUM` raz w miesiącu (w tle, gdy bezczynnie).
- Rozmiar: ~300 B/zdarzenie → 1 mln zdarzeń ≈ 300 MB z indeksami — akceptowalne; w razie potrzeby (M9) tabela dziennych agregatów.

## 12. Agregacje i metryki na żywo

- Granice dni wg lokalnej strefy czasowej systemu (`Intl.DateTimeFormat().resolvedOptions().timeZone`), tydzień od poniedziałku (ustawienie).
- Zapytania (`queries.ts`): `summary(range, filter?)` → `{ costUsd, tokens{…}, events, sessions }`; `byProject(range)`, `byAgent(range)`, `byModel(range)`, `timeseries(range, bucket: 'hour'|'day', groupBy: 'agent'|'project'|'model')`, `sessions(range, filter, page)`, `sessionDetail(id)` (zdarzenia + sparkline).
- **Sesje na żywo:** sesje z `last_event_at` w ostatnich 10 min **lub** z działającym agentem (z `oxy.agents`); dla każdej: agent, model, projekt, terminal, stan agenta (z rdzenia), koszt i tokeny sesji, czas trwania.
- **Burn rate:** koszt z ostatnich 60 min przeliczony na $/h (dla całości i per sesja); tokeny/min z ostatnich 10 min. **Projekcja:** przy aktywnym budżecie „At the current rate, the budget runs out at ~HH:MM”.
- Model widoku dla sidebara liczony po każdej partii nowych zdarzeń (throttle 1 s) i przy zmianie agentów.

## 13. Budżety i limity (pasek „% limitu” z prototypu)

- **Budżety użytkownika** (tabela `budgets`): globalny/projektowy/agentowy; okres dzień/tydzień/miesiąc/blok 5h; w USD lub tokenach; progi powiadomień (domyślnie 80% i 100%) — powiadomienie in-app + OS raz na próg na okres (`budget_alerts`).
- **Bloki 5h (subskrypcje Claude):** jak w ccusage — blok zaczyna się od pełnej godziny pierwszego zdarzenia po zakończeniu poprzedniego bloku i trwa 5 h; aktywny blok: tokeny, koszt, czas do resetu. Limit bloku nie jest publikowany przez Anthropic — użytkownik ustawia własny (`usage.limits.claudeBlock` w tokenach lub USD) lub pasek pokazuje tylko wartości bez %.
- **Realne limity agentów:** Codex `rate_limits.primary/secondary.used_percent` (jeśli obecne) — pokazywane wprost („Codex: 64% of 5h limit, resets in 1h 12m”).
- **Który pasek pokazuje sidebar:** najbardziej „napięty” aktywny limit wg kolejności: realny limit agenta z aktywną sesją > budżet aktywnego projektu > budżet globalny dzienny > blok 5h Claude (jeśli ustawiony limit). Tooltip listuje wszystkie. Kolory: < 70% `--accent`/zielony, 70–90% `--warning`, ≥ 90% `--danger`.

## 14. UI

### 14.1 Widok w sidebarze (`usage.sidebar`) — karta z prototypu

```
USAGE                                                ⋯
Today  $4.82  ·  1.24M tokens              $1.10/h ▲
[█████████████████░░░░░░░░░]  64% of daily budget ($7.50)
ACTIVE SESSIONS
● Claude Code · opus-5-5 · api-server         $2.31
  412k tokens · working · 18 min
◐ Codex · gpt-5.3-codex · web-app            ≈$0.44
  88k tokens · waiting for you
api-server: today $3.10 · last 7 days $18.40
```
- Klik w sesję → `oxytocin.terminal.focus` (jeśli terminal znany) albo szczegóły sesji w dashboardzie.
- Menu ⋯: Open dashboard · Refresh pricing · Usage settings · Data sources.
- Stan pusty: „No usage data yet. Start an agent (e.g. `claude`) in a terminal.” + status źródeł (✓ Claude Code logs found / ✗ Codex not found).
- Wysokość domyślna 180 px; tryb kompaktowy < 120 px (tylko linia „Today” + pasek).
- Wszystkie kwoty z `≈`, gdy wyliczone i `usage.billing.<agent> = 'subscription'`; tooltip wyjaśnia źródło.

### 14.2 Pasek statusu (`usage.today`)

`$(graph) $4.82` (+ `$(sync~spin)` gdy trwa sesja z nowymi zdarzeniami w ostatnich 30 s); tooltip: today / this week / this month, top 3 projects; klik → dashboard. Ustawienie `usage.statusBar: 'today' | 'activeSession' | 'off'`.

### 14.3 Panel dashboard (`usage.dashboard`, singleton)

Zakładki:
1. **Overview** — kafle KPI (dziś, 7 dni, 30 dni, burn rate), wykres słupkowy kosztu dziennego (30 dni) skumulowany per agent (uPlot), tabela projektów (koszt, tokeny, udział %), tabela modeli, rozkład tokenów (input/output/cache read/cache write) jako poziomy pasek skumulowany.
2. **Sessions** — tabela (start, agent, model(e), projekt, terminal, tokeny in/out/cache, koszt, czas; sortowanie, filtr, paginacja); szczegóły: oś czasu zapytań (sparkline kosztu), koszt raportowany vs wyliczony, przycisk „Show terminal”.
3. **Budgets** — lista + formularz (nazwa, zakres, okres, metryka, kwota, progi), stan bieżący z paskami.
4. **Pricing** — tabela znanych modeli (stawki za 1M tokenów: input, output, cache read, cache write 5m/1h), źródło (snapshot/cache/override), data aktualizacji, edycja nadpisań, „Refresh now”, lista nieznanych modeli z danych.
5. **Sources** — dla każdego collectora: włączony, ścieżki, liczba plików, ostatnie zdarzenie, błędy parsowania (licznik + ostatni komunikat bez treści), OTLP: stan serwera, port, liczba odebranych paczek, wykryte konflikty env.

## 15. Ustawienia (`contributes.configuration`, prefiks `usage`)

| Klucz | Typ / domyślnie | Opis |
|---|---|---|
| `usage.sources.claudeCode` | boolean / true | Czytaj logi Claude Code |
| `usage.sources.claudeCode.extraDirs` | string[] / [] | Dodatkowe katalogi konfiguracyjne Claude |
| `usage.sources.codex` | boolean / true | Czytaj rollouty Codex |
| `usage.sources.gemini` | boolean / true | Czytaj czaty Gemini CLI |
| `usage.liveTelemetry.claudeCode` | boolean / false | OTLP dla Claude Code (wstrzykiwanie env) |
| `usage.liveTelemetry.gemini` | boolean / false | OTLP dla Gemini CLI |
| `usage.liveTelemetry.scope` | `'agentProfiles' \| 'allTerminals'` / `'agentProfiles'` | Zakres wstrzykiwania |
| `usage.costMode` | `'auto' \| 'calculate' \| 'reported'` / `'auto'` | Tryb kosztu |
| `usage.billing.claudeCode` / `.codex` / `.gemini` | `'api' \| 'subscription'` / `'api'` | Etykiety „API-equivalent cost” |
| `usage.pricing.autoUpdate` | boolean / true | Codzienne odświeżanie cennika |
| `usage.pricing.overrides` | object / {} | Stawki za 1M tokenów per model |
| `usage.limits.claudeBlock` | `{ metric: 'tokens' \| 'usd', amount: number } \| null` / null | Własny limit bloku 5h |
| `usage.backfillDays` | number / 30 | Zakres indeksowania historii przy pierwszym starcie |
| `usage.retentionDays` | number / 400 | Retencja zdarzeń |
| `usage.statusBar` | `'today' \| 'activeSession' \| 'off'` / `'today'` | Element paska statusu |
| `usage.weekStartsOn` | `'monday' \| 'sunday'` / `'monday'` | Początek tygodnia |

## 16. Prywatność

- Z logów agentów wyciągamy **wyłącznie** metadane zużycia (tokeny, model, czasy, identyfikatory sesji/wiadomości, cwd). Treść wiadomości, promptów, wyników narzędzi nigdy nie jest zapisywana ani logowana (nawet w logach błędów parsowania — logujemy tylko numer linii i typ błędu).
- Baza jest lokalna; brak wysyłki danych. Jedyny ruch sieciowy wtyczki: pobranie cennika (wyłączalne).
- Przy wyłączeniu wtyczki — opcja „Delete collected data” w menedżerze wtyczek.

## 17. Spike'i (na początku M6)

- **S6** — dokładność Claude JSONL vs OTEL (§5.4).
- **S7** — Codex i Gemini: aktualne formaty (zapisać zanonimizowane próbki do `tests/fixtures/codex|gemini`), obecność `rate_limits` w Codex, algorytm `projectHash` Gemini, kodowanie OTLP `http` Gemini (JSON vs protobuf), respektowanie `OTEL_RESOURCE_ATTRIBUTES` przez Gemini.
- Ponieważ na maszynie deweloperskiej nie ma `codex` ani `gemini`, S7 wymaga ich instalacji (`npm i -g @openai/codex @google/gemini-cli`) i krótkich sesji testowych — lub oparcia się na przykładach z dokumentacji/issue i oznaczenia parserów jako „do weryfikacji”.

## 18. Testy

- **Fixtures** (`tests/fixtures/{claude,codex,gemini}/`): zanonimizowane pliki (skrypt `scripts/make-fixtures.ts` usuwa `content`, `text`, `input`, `output` narzędzi, podmienia ścieżki na `C:\\fixture\\proj` / `/fixture/proj`), w tym przypadki brzegowe: wielokrotne linie tego samego `message.id`, placeholder `output_tokens: 1` → późniejsza pełna wartość, `<synthetic>`, subagent, sesja przerwana w połowie linii, podwójne `token_count`, `message_update` Gemini.
- **Unit:** parsery (każde źródło), deduplikacja/upsert (max), delty Codex, normalizacja modeli (tabela przypadków), `computeCost` (złote wartości: np. `claude-opus-5-5`: 1 000 000 input × $0.000004 = $4.00; 100 000 cache read × $0.0000002 = $0.02; 10 000 cache write 1h × $0.000008 = $0.08; 50 000 output × $0.00002 = $1.00; tier > 200k dla modeli z `above200k`; `fastMultiplier`; `priority`), atrybucja cwd (Windows case-insensitive, najdłuższy prefiks), bloki 5h, progi budżetów, tailer (niepełna linia, obcięcie pliku, zmiana `fileId`).
- **Integration:** worker + SQLite w pamięci: backfill katalogu fixture → sumy zgodne z oczekiwanymi; OTLP: wysłanie przykładowego `ExportMetricsServiceRequest` (JSON, gzip) z tokenem i bez.
- **E2E:** start aplikacji z `CLAUDE_CONFIG_DIR=tests/fixtures/claude/home`, `CODEX_HOME=…` → sidebar pokazuje oczekiwany koszt dzisiejszy (fixture z datami przesuwanymi do „today” przez skrypt testu); dopisanie linii do pliku fixture → aktualizacja UI < 2 s; dashboard otwiera się z polecenia.

## 19. Kryteria akceptacji (M6)

- [ ] Koszt i tokeny dla Claude Code, Codex i Gemini CLI z fixture'ów zgodne z wartościami referencyjnymi (co do tokena; koszt co do $0.0001).
- [ ] Nowa odpowiedź agenta pojawia się w sidebarze i pasku statusu w ≤ 2 s (JSONL tail).
- [ ] Sesja Claude Code uruchomiona w terminalu Oxytocin jest przypisana do właściwego projektu i terminala; klik w sesję fokusuje terminal.
- [ ] Brak podwójnego liczenia przy włączonym OTLP i JSONL jednocześnie.
- [ ] Nieznany model → tokeny widoczne, koszt „?”, możliwość dodania stawek, po czym koszt się przelicza.
- [ ] Budżet dzienny: pasek %, powiadomienie przy 80% i 100% (raz na okres).
- [ ] Backfill 30 dni historii (≥ 200 MB JSONL) nie blokuje UI ani innych wtyczek; postęp widoczny.
- [ ] Włączenie „Live telemetry” przy istniejącej konfiguracji OTEL użytkownika nie nadpisuje jej (komunikat w Źródłach).
