# Plan 02 — Project resources: databases and APIs for AI agents

Status: **planned, not started** · Depends on: **Plan 01** (Oxytocin's MCP server, released in 0.6.5 — code in
`src/main/services/mcp/`) · Target: next minor release

This document is written for the agent (or person) who implements the feature. Read it completely, read the MCP server code (Plan 01, `src/main/services/mcp/`),
then follow [Implementation steps](#implementation-steps) in order. Every step ends in a working, released-quality
state (see the owner's rules in `CLAUDE.md`: work on `main`, no feature flags, changelog for user-visible changes).

## Goal and use case

A developer has the projects `bank-api` and `bank-client` in Oxytocin. They right-click a project → **Project
settings…** and describe the project's **resources**: its databases (engine, address, credentials, what agents may do)
and its HTTP APIs (base URL, auth, allowed methods). They test each connection like in an IDE. Oxytocin then gives
the AI agents working in that project a **bridge**: tools on Oxytocin's MCP server (Plan 01) to read the schema,
run queries and call the API. The agent never sees credentials or talks to the database directly through Oxytocin —
every request passes through the bridge, which enforces what the user allowed. Agents are told that the bridge
exists, so they use it instead of hunting for connection strings.

### Decisions already made (by the owner)

- The configuration lives in the existing **Project settings** dialog (context menu of a project), which becomes a
  larger dialog with tabs. No separate window.
- Database engines: **PostgreSQL, Microsoft SQL Server, MySQL, MongoDB** are required; support as many more as is
  reasonable (see [Engines](#engines)).
- Read-only safety is enforced **by the bridge**: it only lets through statements/operations the user allowed.
  Database-level read-only settings are added underneath where they are free (defense in depth), and a read-only
  database account is only *recommended* in the UI.

### Decisions taken by the plan author (change them if the owner objects)

- Agents are informed through the MCP server itself and a Claude Code `SessionStart` hook (no repository files
  touched). Writing a managed block into `AGENTS.md` / `CLAUDE.md` is opt-in per project.
- Extra resource kinds in scope: related projects, links, log files, and an optional shared config file in the
  repository (`.oxytocin/project.json`, never with secrets).

### Non-goals

- A full database IDE (data grid editing, ER diagrams, migrations). The UI only configures and tests; the agent
  queries. A human-facing query console can be a later plan.
- Remote/cloud secret managers (Vault, AWS Secrets Manager).
- Windows integrated authentication as the current user for SQL Server (see [Pitfalls](#pitfalls)).

## Current state (read these files first)

| What | Where |
|---|---|
| Project model and its settings (`defaultProfileId`, `env`, `startupTerminals`, `editorCommand`, `git`) | `src/shared/domain/project.ts` |
| The Project settings dialog (449 lines, one scrolling form with sections) and its model | `src/renderer/src/features/projects/ProjectSettingsDialog.tsx`, `project-settings-model.ts` (+ test) |
| The context-menu entry *Project settings…* | `src/renderer/src/features/projects/ProjectItem.tsx` (~line 204) |
| Project persistence and updates (`ProjectPatchSchema`) | `src/main/services/projects/project-service.ts` |
| JSON store with atomic writes (use for the secret store) | `src/main/services/storage/` |
| Utility processes supervised with restart + health checks, typed RPC | `src/main/hosts/`, `src/shared/rpc/` (`createPortRpc`, contracts in `src/shared/rpc/contracts/`) |
| `node:sqlite` already used in a utility process | `plugins/usage-monitor/src/host/store/db.ts` |
| Claude Code hooks installed as a local Claude Code plugin with `http` hooks; headers interpolate `$OXYTOCIN_TERMINAL_ID` via `allowedEnvVars` | `plugins/claude-code-bridge/src/host/claude-plugin.ts`, `events.ts` |
| Project Runner knows each app's URL (for "base URL from a run profile") | `plugins/project-runner/src/host/` |
| License allowlist (`MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;0BSD;…;MPL-2.0`) | `package.json` → `licenses:check` |
| Plan 01: MCP hub, core tools `oxy_*`, `allow/ask/deny` policies, caller context (which project/terminal calls), call log | `src/main/services/mcp/` (`mcp-hub.ts`, `core-tools.ts`, `tool-registry.ts`, `caller-context.ts`), `src/shared/domain/mcp.ts`, Settings → Agent Tools in `src/renderer/src/features/agent-tools/` |

## Design

### Architecture

```
Renderer: Project settings (tabs)            Agent (Claude Code, Codex, …)
   │ config (no secrets)  │ secrets (write-only)      │ MCP tools oxy_db_*, oxy_api_*, …
   ▼                      ▼                           ▼
main: ProjectService   SecretStore (safeStorage)   McpHub (Plan 01) ── ResourceTools
   │                      │                           │ policy: mode, confirm dialog, audit
   └──────────────┬───────┴───────────────────────────┘
                  ▼  RPC (resolved config + secret per pool)
        src/connections-host (utilityProcess)
          ├─ guard/      statement & operation classifiers (pure, unit-tested)
          ├─ drivers/    pg · mssql · mysql2 · mongodb · node:sqlite · ioredis · @clickhouse/client (lazy import)
          ├─ pools       per resource, max 2 connections, idle close 5 min
          ├─ http/       API requests, OpenAPI fetch + summary
          └─ import/     connection-string parsers (URL, ADO.NET, JDBC)
```

- **Why a new utility process:** drivers, sockets, TLS, parsing and result formatting are heavy and can hang or
  crash; main must stay responsive (no heavy work, no sync I/O). Supervise it with `UtilityHost` like the other
  hosts. Add it to the electron-vite build entries and to the ESLint import-boundary configuration (do not work
  around the boundaries).
- **Drivers are imported lazily** (`await import('pg')`) on first use, so start-up time does not change.
- **Secrets never reach the renderer or the agent.** Main decrypts a secret only to hand it to the connections host
  when a pool is created or a request is made.

### Data model (`src/shared/domain/project-resources.ts`, zod)

Extend `ProjectSettingsSchema` with an optional `resources` object. Sketch (adjust names to the code base):

```ts
const Environment = z.enum(['local', 'dev', 'staging', 'production']);
const AgentExposure = z.object({
  exposed: z.boolean().default(true),           // tools may use this resource
  shareWithRelated: z.boolean().default(false),  // agents of related projects may use it too
  description: z.string().max(2000).optional(),  // told to agents: "balances are in cents", …
});

const DatabaseResource = z.object({
  id: z.string(), name: z.string().min(1).max(100),
  engine: z.enum(['postgresql', 'sqlserver', 'mysql', 'mariadb', 'mongodb', 'sqlite', 'redis', 'clickhouse', 'oracle']),
  environment: Environment.default('local'),
  connection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fields'), host: z.string(), port: z.number().int().optional(), database: z.string().optional(),
               user: z.string().optional(), options: z.record(z.string(), z.string()).default({}) }),
    z.object({ kind: z.literal('url') }),                                            // whole URL is the secret
    z.object({ kind: z.literal('env-ref'), file: z.string(), variable: z.string() }), // read at connect time
    z.object({ kind: z.literal('file'), path: z.string() }),                          // SQLite
  ]),
  tls: z.object({ mode: z.enum(['disable', 'prefer', 'require', 'verify']).default('prefer'),
                  caPath: z.string().optional(), trustServerCertificate: z.boolean().default(false) }).optional(),
  access: z.object({
    mode: z.enum(['read-only', 'confirm-writes', 'read-write']).default('read-only'),
    allowUserFunctions: z.boolean().default(false),
    maxRows: z.number().int().min(1).max(10_000).default(200),
    timeoutMs: z.number().int().min(1000).max(300_000).default(10_000),
    maxResultBytes: z.number().int().default(256 * 1024),
  }),
  masking: z.array(z.string()).default(['*password*', '*secret*', '*token*', '*hash*']), // column/field globs
  agents: AgentExposure,
});

const ApiResource = z.object({
  id: z.string(), name: z.string().min(1).max(100),
  baseUrl: z.union([z.string().url(), z.object({ runProfileId: z.string() })]),
  environment: Environment.default('local'),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('bearer') }),                                        // token = secret
    z.object({ type: z.literal('basic'), user: z.string() }),                       // password = secret
    z.object({ type: z.literal('api-key'), in: z.enum(['header', 'query']), name: z.string() }),
    z.object({ type: z.literal('headers'), names: z.array(z.string()) }),           // values = secrets
  ]),
  access: z.object({
    methods: z.array(z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])).default(['GET', 'HEAD', 'OPTIONS']),
    confirmMethods: z.array(z.string()).default([]),   // allowed, but each call asks the user
    allowPaths: z.array(z.string()).default(['/**']), denyPaths: z.array(z.string()).default([]),
    timeoutMs: z.number().int().default(30_000), maxResponseBytes: z.number().int().default(256 * 1024),
    allowSelfSignedOnLoopback: z.boolean().default(false),
  }),
  openapi: z.object({ source: z.enum(['auto', 'url', 'file', 'off']).default('auto'), value: z.string().optional() }),
  healthPath: z.string().optional(),
  agents: AgentExposure,
});

const ProjectResources = z.object({
  databases: z.array(DatabaseResource).default([]),
  apis: z.array(ApiResource).default([]),
  links: z.array(z.object({ id: z.string(), title: z.string(), url: z.string().url() })).default([]),
  logs: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() /* file or glob */ })).default([]),
  relatedProjectIds: z.array(z.string()).default([]),
  agentBrief: z.object({ sessionHook: z.boolean().default(true),
                         instructionsFile: z.enum(['none', 'AGENTS.md', 'CLAUDE.md']).default('none') }).default({}),
});
```

Rules: `production` forbids `read-write` (only `read-only` or `confirm-writes`). Unknown future fields must survive a
round trip (do not strip them when older code saves).

### Secret store (`src/main/services/secrets/`)

- Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). Only usable in main after
  `app.whenReady()`.
- File `secrets.json` in userData, written with the existing atomic JSON store: `{ "<projectId>/<resourceId>/<key>":
  "<base64 ciphertext>" }`. Encrypting/decrypting is small CPU work; file I/O stays async.
- IPC is **write-only** for the renderer: `secrets:set`, `secrets:delete`, `secrets:status` (returns `hasSecret`
  booleans only). There is no IPC that returns a plaintext secret. Validate every payload with zod; register through
  `src/main/ipc/router.ts` (sender check).
- On Linux, when `safeStorage.getSelectedStorageBackend()` is `basic_text` (no keyring), show a warning in the
  dialog that secrets are only obfuscated; still allow saving.
- Deleting a resource or a project deletes its secrets. Never log secrets, never include them in errors (drivers put
  connection strings in error messages — scrub them, see [Pitfalls](#pitfalls)).

### Engines

| Engine | Package (license) | Compatible products | Read-only layers (bridge first, database second) | Notes |
|---|---|---|---|---|
| PostgreSQL | `pg` (MIT) | CockroachDB, TimescaleDB, Supabase, Neon, Aurora/AlloyDB | SQL guard (PG grammar) + `default_transaction_read_only=on` + `BEGIN READ ONLY … ROLLBACK`; `statement_timeout` | Strong. |
| SQL Server | `mssql` → `tedious` (MIT) | Azure SQL | SQL guard (T-SQL) + every read runs in `BEGIN TRAN … ROLLBACK`; request timeout | No read-only transactions in SQL Server — the guard is the main layer. `encrypt` defaults to on: offer *Trust server certificate* for local dev. Named instances (`HOST\SQLEXPRESS`) via `instanceName`. |
| MySQL | `mysql2` (MIT) | Aurora MySQL, PlanetScale, TiDB | SQL guard (MySQL) + `multipleStatements: false` + `START TRANSACTION READ ONLY … ROLLBACK`; `max_execution_time` | DDL commits implicitly — the guard must reject it in read-only mode. |
| MariaDB | `mysql2` (MIT) | — | as MySQL (MariaDB dialect) | Do **not** use the `mariadb` package (LGPL). |
| MongoDB | `mongodb` (Apache-2.0) | Atlas, DocumentDB (partially), Cosmos DB for MongoDB | Operation allowlist (below); `maxTimeMS` | `mongodb+srv://` needs DNS SRV lookups — fine in Node. |
| SQLite | `node:sqlite` (built in) | — | Opened with `readOnly: true` in read-only mode + guard (reject `ATTACH`, `PRAGMA` writes) | Strongest guarantee. File path relative to the project root allowed. |
| Redis / Valkey | `ioredis` (MIT) | — | Command allowlist | Step 8. |
| ClickHouse | `@clickhouse/client` (Apache-2.0) | — | Server setting `readonly=1` per query (server-enforced) + simple guard; `max_execution_time` | Step 8. HTTP-based. |
| Oracle | `oracledb` thin mode (`Apache-2.0 OR UPL-1.0`) | — | `SET TRANSACTION READ ONLY` + simple guard | Optional, step 9. Verify that `licenses:check` accepts the OR expression and whether its install script must be approved (`allowScripts`). |

### The bridge's guard (core of the safety story)

The agent reaches a database only through Oxytocin's tools; the guard decides what passes. It lives in
`src/connections-host/guard/` as pure functions with exhaustive unit tests.

**SQL engines** — `classify(dialect, text) → { statements, kind: 'read' | 'write' | 'ddl' | 'dcl' | 'unknown',
tables, flags }`:

1. Exactly **one statement** per call (after stripping comments); otherwise reject.
2. Parse with a real parser for the dialect: `pgsql-ast-parser` (MIT, ~1.7 MB) for PostgreSQL — or `libpg-query`
   (MIT, PostgreSQL's own parser) if its build works on all three platforms without a compiler; `node-sql-parser`
   (Apache-2.0) for MySQL/MariaDB (`mysql`/`mariadb`), SQL Server (`transactsql`) and SQLite (`sqlite`). The full
   `node-sql-parser` package is ~92 MB unpacked: import **only the per-dialect builds** and check the bundled size.
3. **Anything that cannot be parsed is rejected** with a message telling the agent to simplify the query.
4. `read` means: `SELECT`, `WITH … SELECT` whose CTEs are all `SELECT`, `EXPLAIN` **without** `ANALYZE`, `SHOW`,
   `DESCRIBE`/`DESC`, `VALUES`. Everything else is not `read`.
5. Reads are still rejected in read-only mode when they contain: `SELECT … INTO` (creates tables), `INTO OUTFILE` /
   `DUMPFILE`, `FOR UPDATE` / `FOR SHARE` / `LOCK IN SHARE MODE`, data-modifying CTEs, and calls to denylisted
   functions: sequences (`nextval`, `setval`), session/process control (`pg_terminate_backend`,
   `pg_cancel_backend`, `KILL`), file and network access (`pg_read_file`, `pg_ls_dir`, `lo_import`, `lo_export`,
   `dblink*`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `LOAD_FILE`), delays (`pg_sleep`, `SLEEP`, `BENCHMARK`,
   `WAITFOR`), and `EXEC`/`EXECUTE`/`CALL`. Keep the denylist in one table per dialect with a test per entry.
6. User-defined functions: in read-only mode only **built-in** functions are allowed unless the resource enables
   `allowUserFunctions` (the bridge cannot know whether a custom function writes).
7. The guard's result is attached to the response so the agent learns *why* something was refused.

**Test corpus (must be rejected in read-only mode):** `WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x` ·
`SELECT * INTO backup FROM users` · `SELECT … INTO OUTFILE '/tmp/x'` · `SELECT nextval('seq')` ·
`SELECT pg_terminate_backend(1)` · `EXPLAIN ANALYZE DELETE FROM users` · `SELECT 1; DROP TABLE users` ·
`SELECT * FROM users FOR UPDATE` · `SELECT my_cleanup()` (without `allowUserFunctions`) · `/* x */ DELETE FROM users`.
Plus a corpus of ordinary reads (joins, window functions, JSON operators, `ILIKE`, `TOP`, `LIMIT/OFFSET`, `ORDER BY`
with `NULLS LAST`, T-SQL `[bracketed]` names) that must pass, so the guard is not so strict that agents give up.

**Write modes.** `confirm-writes`: every non-read asks the user (Plan 01's *ask* dialog) showing the kind, the
affected tables and the full SQL; *Deny* returns an error to the agent. `read-write`: writes run without asking,
**except** `DROP`, `TRUNCATE`, `ALTER … DROP`, and `UPDATE`/`DELETE` without `WHERE`, which always ask. Writes run
in a transaction that is committed only after success.

**MongoDB** — no free-form commands. Allowed in read-only mode: `find`, `findOne`, `aggregate`, `countDocuments`,
`estimatedDocumentCount`, `distinct`, `listCollections`, `listIndexes`, `collStats`. `aggregate` pipelines are
rejected when they contain `$out`, `$merge`, `$function`, `$accumulator`, or `$where` anywhere (walk the whole
document, including nested pipelines in `$lookup`/`$facet`/`$unionWith`). Filters with `$where`/`$function` are
rejected. Writes (`insertOne/Many`, `updateOne/Many`, `replaceOne`, `deleteOne/Many`) follow the write modes;
`deleteMany({})` / `updateMany({}, …)` always ask. `drop`/`dropDatabase` are never offered.

**Redis** — allowlist: `GET MGET STRLEN EXISTS TYPE TTL PTTL HGET HMGET HGETALL HKEYS HLEN LRANGE LLEN SMEMBERS
SCARD SISMEMBER ZRANGE ZRANGEBYSCORE ZCARD ZSCORE SCAN HSCAN SSCAN ZSCAN XRANGE XLEN INFO DBSIZE`. `KEYS` is replaced
by `SCAN` (performance). Never: `EVAL*`, `FUNCTION`, `CONFIG`, `FLUSH*`, `SHUTDOWN`, `DEBUG`, `MODULE`, `SCRIPT`.

**Honest limit (say it in the UI in one sentence):** the bridge controls what goes *through Oxytocin*. An agent with
a shell can still read a connection string from `.env` and run `psql` itself; that is governed by the agent's own
permissions. The bridge is the recommended, safe path — not a sandbox.

### Results returned to the agent

- SQL: column names and types, then rows as a compact Markdown table (or JSON when asked via `format: 'json'`).
  Cap by `maxRows` and `maxResultBytes`; say how many rows were cut ("200 of 5,312 rows shown — add a WHERE or
  LIMIT"). Cells over ~2 KB are truncated; binary values become `<binary 1,024 bytes>`; dates in ISO 8601.
- Masking: values of columns/fields matching `masking` globs (case-insensitive) become `***`. Applied in the host,
  before anything leaves it — also in schema samples.
- Errors: driver error code and message with secrets scrubbed, plus a hint (unknown table → "call oxy_db_schema").

### Agent tools (core tools in the Plan 01 hub)

All tools resolve the **caller's project** with Plan 01's caller context and only see that project's exposed
resources, plus resources of related projects marked `shareWithRelated`. They are listed in `tools/list` only when
at least one project has an exposed resource of that kind (keeps the tool list short for everyone else); adding the
first resource triggers `list_changed`.

| Tool | Purpose |
|---|---|
| `oxy_project_resources` | Databases, APIs, links and logs available to the caller: name, engine/URL, environment, access mode, description. Never secrets. |
| `oxy_db_schema(database, schema?, table?)` | SQL: schemas, tables/views, columns (type, nullable, default), primary/foreign keys, indexes. MongoDB: collections, indexes, a field-shape summary from a small sample (masked). Redis: `INFO keyspace` and sampled key patterns. Cached per resource for 60 s. |
| `oxy_db_query(database, query, params?, maxRows?, format?)` | SQL engines and ClickHouse; parameters are bound, never interpolated. |
| `oxy_mongo(database, collection, operation, args)` | MongoDB operations from the allowlist / write modes. |
| `oxy_redis(database, command, args)` | Redis allowlist. |
| `oxy_api_describe(api, filter?, operation?)` | OpenAPI summary: method, path, summary, parameters, body schema names; one operation in full when `operation` is given. |
| `oxy_api_request(api, method, path, query?, headers?, body?)` | Calls the API with auth added by Oxytocin. If the base URL comes from a run profile that is not running, the error says so and suggests `run_start_profile`. |
| `oxy_logs_tail(log, lines?, grep?)` | Last lines of a configured log file (newest file for a glob), optional regex filter, capped. |

Every call is written to the Plan 01 call log. For resource tools the log also keeps the **query text / method +
path** (truncated, no results), because it is the audit trail users want; the *Agents* tab can clear it.

### APIs

- Requests go only to the **origin of the base URL**; the `path` argument must be a path (no scheme/host), is
  normalized (no `..` escapes) and checked against `allowPaths`/`denyPaths` (glob). Redirects are followed only
  within the same origin (max 5). Auth headers are never sent anywhere else.
- Agent-supplied headers cannot override auth headers, `Host`, or `Cookie`.
- `allowSelfSignedOnLoopback`: certificate errors are ignored only when the host is `localhost`/`127.0.0.1`/`::1`
  (ASP.NET / Vite dev certificates). Use `node:https` with `rejectUnauthorized: false` for that request only.
- Response to the agent: status, selected headers (`content-type`, `location`, rate-limit headers; `set-cookie`
  masked), body pretty-printed when JSON, truncated to `maxResponseBytes`, binary described.
- OpenAPI `auto`: try `/swagger/v1/swagger.json`, `/openapi.json`, `/v3/api-docs`, `/swagger.json` on the base URL;
  YAML specs need a YAML parser (`yaml`, ISC). Cache the parsed spec with its ETag.
- Base URL from a run profile: resolve through a public command of the Project Runner (add one, e.g.
  `projectRunner.resolveUrl`). If the plugin is disabled, the resource falls back to a static URL the user entered.

### Import from the project

*Databases → Import from project…* scans the project root (async, bounded depth, ignore `node_modules`/`bin`/`obj`)
and offers detected connections:

- `.env*`: `DATABASE_URL`, `*_DATABASE_URL`, `POSTGRES_*`, `MYSQL_*`, `MONGO_URI`/`MONGODB_URI`, `REDIS_URL`.
- `appsettings*.json` → `ConnectionStrings` (ADO.NET `Server=…;Database=…;User Id=…;Password=…;
  TrustServerCertificate=True` and Npgsql `Host=…;Username=…`).
- `application.properties` / `application.yml` → `spring.datasource.url` (JDBC URLs), `spring.data.mongodb.uri`.
- `docker-compose*.yml` → `postgres`/`mysql`/`mariadb`/`mongo`/`redis`/`mssql` images with their env and ports.
- `prisma/schema.prisma` → `datasource … url = env("…")` (points to the `.env` variable).

For each, the user chooses **reference** (`env-ref`: read the value from the file at connect time — nothing copied)
or **copy into Oxytocin** (the secret goes into the secret store). Parsers are pure functions with unit tests.

### Informing the agents

1. **MCP**: the tool descriptions and Plan 01's dynamic `initialize.instructions` mention the resources.
2. **Claude Code `SessionStart` hook** (default on, `agentBrief.sessionHook`): extend the Claude Code Bridge's hook
   set with `SessionStart`. Its `http` hook reaches the bridge with `X-Oxytocin-Terminal`; the bridge asks core for a
   brief (a new public core command, e.g. `oxytocin.resources.agentBrief({ terminalId })`) and answers with
   `hookSpecificOutput.additionalContext`, e.g.: *"This project's resources are available through Oxytocin's MCP
   tools: database `bank-db` (PostgreSQL, dev, read-only) — use oxy_db_schema / oxy_db_query; API `bank-api`
   (http://localhost:3452, GET only, OpenAPI available) — use oxy_api_describe / oxy_api_request. Use these tools
   instead of looking for credentials."* **Verify** that Claude Code applies `additionalContext` from an `http` hook
   response (record it in the verification log); if it does not, fall back to MCP instructions only.
3. **Instructions file** (opt-in, `agentBrief.instructionsFile`): a managed block between
   `<!-- oxytocin:resources:start -->` and `<!-- oxytocin:resources:end -->` in `AGENTS.md` or `CLAUDE.md`, written
   only after the user presses *Write to AGENTS.md* and then kept up to date. Never secrets, never hostnames of
   `production` resources. The change shows up in the Changes panel like any edit.

### Related projects, links, logs, shared config

- **Related projects** (`relatedProjectIds`, stored on both sides when linked): the agent of `bank-client` may use
  `bank-api`'s resources marked `shareWithRelated` (typically its API and OpenAPI). The Agents tab can also suggest
  starting Claude Code with `--add-dir <related project root>`.
- **Links**: title + URL (tracker, design, staging, docs); shown in the project's context menu and returned by
  `oxy_project_resources`.
- **Logs**: named file paths or globs, may be outside the project (e.g. `C:\logs\bank-api\*.log`); read by
  `oxy_logs_tail` in the connections host (async, read from the end, capped).
- **Shared config file** `.oxytocin/project.json` in the repository (opt-in *Save to repository*): resources
  without secrets and without `production` hostnames. On opening a project that has this file, Oxytocin asks once
  per file version whether to use it (*"This repository defines 2 databases and 1 API"*), because a repository could
  otherwise point agents at hosts the user did not choose. Local settings override the file; secrets stay local.

### Project settings dialog

- Wider dialog (≈ 880 px, max 90 vw/vh) with a tab list on the left: **General** (name, icon, color, default
  profile, editor) · **Terminals** (startup terminals) · **Environment** · **Git** · **Databases** · **APIs** ·
  **Links & logs** · **Related projects** · **Agents**. Existing sections move into tabs unchanged.
- Databases/APIs tabs: list on the left, form on the right; engine picker with icons; fields per engine; *Import from
  project…*; *Test connection* (shows server version, latency, or a clear error: authentication failed / host
  unreachable / TLS / database missing / timeout); access mode as a segmented control with a yellow note for
  `confirm-writes` and a red warning for `read-write` (which needs an explicit confirmation to enable); limits;
  masking patterns; *Available to agents* and *Share with related projects* switches; description for agents;
  the one-sentence honest-limit note.
- Secrets: password fields show `••••••` when set and *Change* / *Remove*; typing a new value sends it straight to
  `secrets:set` on save.
- Agents tab: session-hook switch, instructions-file choice with a preview of the brief, the project's call log.
- Colors and sizes only through CSS tokens; keyboard accessible; Escape closes (asks when there are unsaved
  changes).

## Pitfalls

- **Build on Plan 01.** The tools, policies (*ask* dialog), caller context and call log come from Oxytocin's MCP
  server (`src/main/services/mcp/`, released in 0.6.5).
- **Every step ships.** No feature flags; each step must leave a complete, usable feature (see steps below).
- **Secrets in error messages and logs:** drivers include connection strings, hostnames and sometimes passwords in
  errors. Scrub every error in the host (replace the secret values and URL credentials) before it leaves the process;
  test it.
- **SQL Server LocalDB** (`(localdb)\MSSQLLocalDB`, common for .NET developers) uses named pipes; `tedious` speaks TCP
  only, so it is not supported. Say so in the form with a hint (SQL Server Express/Developer or Docker). Windows
  integrated auth *as the current user* is not supported by `tedious` either; NTLM with explicit credentials is.
- **SQL Server TLS:** `tedious` encrypts by default; local servers with self-signed certificates fail until
  *Trust server certificate* is on — surface that in the test error.
- **MySQL implicit commits:** DDL ends transactions; `ROLLBACK` does not undo it. The guard must stop DDL before it
  reaches the server in read-only and confirm modes.
- **Parser gaps:** parsers lag behind dialects. Rejecting unparsable SQL is intended; keep the "must pass" corpus
  realistic and extend it when agents hit false rejections.
- **Pools and timeouts:** always set server-side timeouts where the engine supports them and a client-side abort;
  close pools on resource change, project removal, idle, and host shutdown. A hung driver must never block main.
- **Windows (primary platform):** paths in `file`/`logs`/`env-ref` may use backslashes and drive letters; SQLite files
  can be locked by the running app (open read-only, `busy_timeout`); corporate proxies may affect API calls to
  non-loopback hosts (use no proxy for loopback).
- **Bundle size and install scripts:** check `out/` size after adding drivers; `oracledb` and `ssh2` have install
  scripts (npm 11 `allowScripts`), keep them to the optional steps. Run `npm run licenses:check` and
  `npm run licenses:notices` after adding production dependencies.
- **Round-trip safety of settings:** older/newer app versions must not drop unknown resource fields.
- **Never** send secrets to the renderer, plugins, the call log, crash reports or the agent.

## Implementation steps

Each step: code + tests, `npm run check` green, relevant E2E green (`xvfb-run -a npm run e2e` on Linux), changelog
entry for user-visible changes, commit on `main` (Conventional Commits, authored as the owner, no trailers), push.

1. **Project settings with tabs + secret store.** Move the existing sections into tabs (no behavior change), add the
   secret store and its write-only IPC. E2E: existing project-settings tests still pass, tabs switch.
2. **Databases: vertical slice with PostgreSQL and SQLite.** Connections host (supervised), pools, guard for
   PostgreSQL and SQLite with the full corpus, masking, result formatting, error scrubbing; Databases tab with form,
   test connection and access modes; tools `oxy_project_resources`, `oxy_db_schema`, `oxy_db_query` in the hub with
   write modes. E2E with a SQLite fixture database: add it, test it, an MCP client lists the tables, a read works, a
   write is refused in read-only and asks in confirm mode.
3. **SQL Server, MySQL, MariaDB.** Drivers, dialect guards and corpora, engine-specific form fields (instance name,
   trust server certificate, MySQL/MariaDB TLS).
4. **MongoDB.** Driver, operation allowlist and pipeline walker, `oxy_mongo`, schema sampling with masking.
5. **APIs.** APIs tab, auth kinds, method/path rules, same-origin enforcement, self-signed on loopback, test,
   OpenAPI discovery and summary, `oxy_api_describe`, `oxy_api_request`, base URL from a run profile. E2E against a
   local HTTP test server with an OpenAPI document.
6. **Import from project.** Detectors and parsers (`.env`, `appsettings*.json`, Spring, docker-compose, Prisma), the
   import dialog with reference/copy choice.
7. **Informing agents.** `SessionStart` hook in the Claude Code Bridge + core brief command; managed block in
   `AGENTS.md`/`CLAUDE.md`; Agents tab with preview and the project's call log.
8. **Related projects, links, logs, shared config; Redis and ClickHouse.** `shareWithRelated`, `--add-dir`
   suggestion, links in the context menu, `oxy_logs_tail`, `.oxytocin/project.json` with the trust prompt; Redis
   allowlist + `oxy_redis`; ClickHouse with `readonly=1`.
9. **Optional:** Oracle (thin mode), SSH tunnels (`ssh2`), Azure AD authentication for SQL Server. Only after the
   license/install-script checks in the verification log.
10. **Wrap up.** README feature list; after the release that contains the feature, rename this file to
    `02-released-…` (or delete it).

Integration tests for PostgreSQL, SQL Server, MySQL/MariaDB, MongoDB and Redis run against real servers only when
their connection URLs are provided through environment variables (`OXY_TEST_PG_URL`, …) and are skipped otherwise;
SQLite and the HTTP tests always run. Guards, parsers, masking and formatting are covered by unit tests independent
of any server.

## Definition of done

- A project's databases (at least PostgreSQL, SQL Server, MySQL/MariaDB, MongoDB, SQLite) and APIs are configured and
  tested in Project settings; secrets are encrypted and never leave main except to the connections host.
- Agents in that project list, inspect and query them through `oxy_*` tools; read-only mode refuses the whole
  rejection corpus; confirm mode asks; `production` cannot be set to read-write.
- Agents are told about the resources (MCP instructions, and the `SessionStart` brief if verified).
- Import from `.env` / `appsettings.json` / Spring / docker-compose works.
- Tests as listed; `npm run check` green; docs and changelog updated.

## Verification log

Fill in while implementing.

- Claude Code applies `additionalContext` from an `http` `SessionStart` hook response: _
- `pgsql-ast-parser` vs `libpg-query` chosen, and why: _
- Bundled size of the per-dialect `node-sql-parser` builds: _
- `licenses:check` accepts `oracledb`'s `(Apache-2.0 OR UPL-1.0)`: _
- `tedious` against SQL Server Express on Windows (named instance, trust server certificate): _
