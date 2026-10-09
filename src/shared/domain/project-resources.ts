import { z } from 'zod';

/**
 * Project resources: the databases, HTTP APIs, links and log files of a project, which AI agents use through
 * Oxytocin's MCP tools (the "bridge"). The configuration never contains secrets: passwords, tokens and connection URLs
 * live in the encrypted secret store (main process only).
 *
 * Every object is loose so fields added by newer versions survive a round trip through an older one.
 */

export const RESOURCE_ENVIRONMENTS = ['local', 'dev', 'staging', 'production'] as const;
export const ResourceEnvironmentSchema = z.enum(RESOURCE_ENVIRONMENTS);
export type ResourceEnvironment = z.infer<typeof ResourceEnvironmentSchema>;

export const DATABASE_ENGINES = [
  'postgresql',
  'cockroachdb',
  'sqlserver',
  'mysql',
  'mariadb',
  'mongodb',
  'sqlite',
  'redis',
  'clickhouse',
  'oracle',
] as const;
export const DatabaseEngineSchema = z.enum(DATABASE_ENGINES);
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>;

/** Dialects of the SQL guard. */
export type SqlDialect = 'postgresql' | 'sqlserver' | 'mysql' | 'mariadb' | 'sqlite' | 'clickhouse' | 'oracle';

export interface EngineInfo {
  label: string;
  /** Products that speak the same protocol (shown in the engine picker). */
  compatible: string;
  family: 'sql' | 'mongodb' | 'redis';
  dialect?: SqlDialect;
  defaultPort?: number;
  /** URL schemes accepted for a connection URL. */
  urlSchemes: string[];
  /** A file database (SQLite). */
  file?: boolean;
  /** The engine has a notion of a user name. */
  user: boolean;
  /** Default user shown as a placeholder. */
  defaultUser?: string;
  /** Default database shown as a placeholder. */
  databaseHint?: string;
}

export const ENGINE_INFO: Record<DatabaseEngine, EngineInfo> = {
  postgresql: {
    label: 'PostgreSQL',
    compatible: 'TimescaleDB, Supabase, Neon, Aurora/AlloyDB, YugabyteDB',
    family: 'sql',
    dialect: 'postgresql',
    defaultPort: 5432,
    urlSchemes: ['postgres', 'postgresql'],
    user: true,
    defaultUser: 'postgres',
    databaseHint: 'postgres',
  },
  cockroachdb: {
    label: 'CockroachDB',
    compatible: 'PostgreSQL wire protocol',
    family: 'sql',
    dialect: 'postgresql',
    defaultPort: 26257,
    urlSchemes: ['postgres', 'postgresql', 'cockroachdb'],
    user: true,
    defaultUser: 'root',
    databaseHint: 'defaultdb',
  },
  sqlserver: {
    label: 'SQL Server',
    compatible: 'Azure SQL',
    family: 'sql',
    dialect: 'sqlserver',
    defaultPort: 1433,
    urlSchemes: ['sqlserver', 'mssql'],
    user: true,
    defaultUser: 'sa',
    databaseHint: 'master',
  },
  mysql: {
    label: 'MySQL',
    compatible: 'Aurora MySQL, PlanetScale, TiDB',
    family: 'sql',
    dialect: 'mysql',
    defaultPort: 3306,
    urlSchemes: ['mysql'],
    user: true,
    defaultUser: 'root',
  },
  mariadb: {
    label: 'MariaDB',
    compatible: 'MariaDB SkySQL',
    family: 'sql',
    dialect: 'mariadb',
    defaultPort: 3306,
    urlSchemes: ['mariadb', 'mysql'],
    user: true,
    defaultUser: 'root',
  },
  mongodb: {
    label: 'MongoDB',
    compatible: 'Atlas, DocumentDB, Cosmos DB for MongoDB',
    family: 'mongodb',
    defaultPort: 27017,
    urlSchemes: ['mongodb', 'mongodb+srv'],
    user: true,
  },
  sqlite: {
    label: 'SQLite',
    compatible: 'a local database file',
    family: 'sql',
    dialect: 'sqlite',
    urlSchemes: ['sqlite', 'file'],
    file: true,
    user: false,
  },
  redis: {
    label: 'Redis',
    compatible: 'Valkey, KeyDB, Dragonfly',
    family: 'redis',
    defaultPort: 6379,
    urlSchemes: ['redis', 'rediss'],
    user: true,
  },
  clickhouse: {
    label: 'ClickHouse',
    compatible: 'ClickHouse Cloud (HTTP interface)',
    family: 'sql',
    dialect: 'clickhouse',
    defaultPort: 8123,
    urlSchemes: ['clickhouse', 'http', 'https'],
    user: true,
    defaultUser: 'default',
    databaseHint: 'default',
  },
  oracle: {
    label: 'Oracle',
    compatible: 'Oracle Database 12.1+ (thin mode), Autonomous Database',
    family: 'sql',
    dialect: 'oracle',
    defaultPort: 1521,
    urlSchemes: ['oracle'],
    user: true,
    databaseHint: 'service name, e.g. FREEPDB1',
  },
};

/** Engines whose queries go through `oxy_db_query` (SQL). */
export const isSqlEngine = (engine: DatabaseEngine): boolean => ENGINE_INFO[engine].family === 'sql';

export const ACCESS_MODES = ['read-only', 'confirm-writes', 'read-write'] as const;
export const AccessModeSchema = z.enum(ACCESS_MODES);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const AgentExposureSchema = z.looseObject({
  /** Agents may use this resource through Oxytocin's tools. */
  exposed: z.boolean().default(true),
  /** Agents of related projects may use it too. */
  shareWithRelated: z.boolean().default(false),
  /** Told to agents ("balances are in cents", …). */
  description: z.string().max(2000).optional(),
});
export type AgentExposure = z.infer<typeof AgentExposureSchema>;

export const DatabaseConnectionSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('fields'),
    host: z.string().max(500).default(''),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().max(500).optional(),
    user: z.string().max(500).optional(),
    /** Engine-specific options (e.g. SQL Server `instanceName`, `domain`; MongoDB `authSource`). */
    options: z.record(z.string(), z.string().max(2000)).default({}),
  }),
  /** The whole connection URL is a secret (`url`). */
  z.looseObject({ kind: z.literal('url') }),
  /** Read the URL from a variable of an env file at connect time (nothing is copied). */
  z.looseObject({
    kind: z.literal('env-ref'),
    /** Relative to the project root, or absolute. */
    file: z.string().min(1).max(1000),
    variable: z.string().min(1).max(200),
  }),
  /** SQLite: a database file, relative to the project root or absolute. */
  z.looseObject({ kind: z.literal('file'), path: z.string().min(1).max(1000) }),
]);
export type DatabaseConnection = z.infer<typeof DatabaseConnectionSchema>;

export const TlsModeSchema = z.enum(['disable', 'prefer', 'require', 'verify']);
export type TlsMode = z.infer<typeof TlsModeSchema>;

export const DatabaseTlsSchema = z.looseObject({
  mode: TlsModeSchema.default('prefer'),
  /** A CA certificate file (PEM) for `verify`. */
  caPath: z.string().max(1000).optional(),
  /** SQL Server: accept a self-signed server certificate (local development). */
  trustServerCertificate: z.boolean().default(false),
});
export type DatabaseTls = z.infer<typeof DatabaseTlsSchema>;

export const DB_LIMITS = {
  maxRows: { min: 1, max: 10_000, default: 200 },
  timeoutMs: { min: 1000, max: 300_000, default: 10_000 },
  maxResultBytes: { min: 4 * 1024, max: 4 * 1024 * 1024, default: 256 * 1024 },
} as const;

export const DatabaseAccessSchema = z.looseObject({
  mode: AccessModeSchema.default('read-only'),
  /** In read-only mode: allow functions that are not built into the engine (the bridge cannot know what they do). */
  allowUserFunctions: z.boolean().default(false),
  maxRows: z.number().int().min(DB_LIMITS.maxRows.min).max(DB_LIMITS.maxRows.max).default(DB_LIMITS.maxRows.default),
  timeoutMs: z
    .number()
    .int()
    .min(DB_LIMITS.timeoutMs.min)
    .max(DB_LIMITS.timeoutMs.max)
    .default(DB_LIMITS.timeoutMs.default),
  maxResultBytes: z
    .number()
    .int()
    .min(DB_LIMITS.maxResultBytes.min)
    .max(DB_LIMITS.maxResultBytes.max)
    .default(DB_LIMITS.maxResultBytes.default),
});
export type DatabaseAccess = z.infer<typeof DatabaseAccessSchema>;

export const DEFAULT_MASKING = ['*password*', '*passwd*', '*secret*', '*token*', '*hash*', '*api_key*', '*apikey*'];

export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ResourceIdSchema = z.string().regex(RESOURCE_ID_PATTERN);
const ResourceNameSchema = z.string().trim().min(1).max(100);

export const DatabaseResourceSchema = z.looseObject({
  id: ResourceIdSchema,
  name: ResourceNameSchema,
  engine: DatabaseEngineSchema,
  environment: ResourceEnvironmentSchema.default('local'),
  connection: DatabaseConnectionSchema,
  tls: DatabaseTlsSchema.optional(),
  access: DatabaseAccessSchema.default({
    mode: 'read-only',
    allowUserFunctions: false,
    maxRows: DB_LIMITS.maxRows.default,
    timeoutMs: DB_LIMITS.timeoutMs.default,
    maxResultBytes: DB_LIMITS.maxResultBytes.default,
  }),
  /** Column/field name globs whose values agents never see (`***`), case-insensitive. */
  masking: z.array(z.string().min(1).max(200)).max(100).default(DEFAULT_MASKING),
  agents: AgentExposureSchema.default({ exposed: true, shareWithRelated: false }),
});
export type DatabaseResource = z.infer<typeof DatabaseResourceSchema>;

export const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS'];

export const ApiAuthSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('none') }),
  /** Secret `token`. */
  z.looseObject({ type: z.literal('bearer') }),
  /** Secret `password`. */
  z.looseObject({ type: z.literal('basic'), user: z.string().max(500) }),
  /** Secret `apiKey`. */
  z.looseObject({ type: z.literal('api-key'), in: z.enum(['header', 'query']), name: z.string().min(1).max(200) }),
  /** Secrets `header:<name>`. */
  z.looseObject({ type: z.literal('headers'), names: z.array(z.string().min(1).max(200)).max(20) }),
]);
export type ApiAuth = z.infer<typeof ApiAuthSchema>;

export const API_LIMITS = {
  timeoutMs: { min: 1000, max: 300_000, default: 30_000 },
  maxResponseBytes: { min: 4 * 1024, max: 4 * 1024 * 1024, default: 256 * 1024 },
} as const;

export const ApiAccessSchema = z.looseObject({
  methods: z.array(HttpMethodSchema).default([...SAFE_METHODS]),
  /** Allowed, but each call asks the user first. */
  confirmMethods: z.array(HttpMethodSchema).default([]),
  /** Path globs (`*` one segment, `**` any) relative to the base URL. */
  allowPaths: z.array(z.string().min(1).max(500)).max(100).default(['/**']),
  denyPaths: z.array(z.string().min(1).max(500)).max(100).default([]),
  timeoutMs: z
    .number()
    .int()
    .min(API_LIMITS.timeoutMs.min)
    .max(API_LIMITS.timeoutMs.max)
    .default(API_LIMITS.timeoutMs.default),
  maxResponseBytes: z
    .number()
    .int()
    .min(API_LIMITS.maxResponseBytes.min)
    .max(API_LIMITS.maxResponseBytes.max)
    .default(API_LIMITS.maxResponseBytes.default),
  /** Ignore certificate errors for localhost / 127.0.0.1 / ::1 only (dev certificates). */
  allowSelfSignedOnLoopback: z.boolean().default(false),
});
export type ApiAccess = z.infer<typeof ApiAccessSchema>;

export const ApiBaseUrlSchema = z.union([
  z.string().max(2000),
  /** The URL of a Project Runner profile; `fallback` is used when the runner cannot tell. */
  z.looseObject({ runProfileId: z.string().min(1).max(200), fallback: z.string().max(2000).optional() }),
]);
export type ApiBaseUrl = z.infer<typeof ApiBaseUrlSchema>;

export const OpenApiSourceSchema = z.looseObject({
  source: z.enum(['auto', 'url', 'file', 'off']).default('auto'),
  /** URL (absolute or a path on the API) or file path, depending on `source`. */
  value: z.string().max(2000).optional(),
});

export const ApiResourceSchema = z.looseObject({
  id: ResourceIdSchema,
  name: ResourceNameSchema,
  baseUrl: ApiBaseUrlSchema,
  environment: ResourceEnvironmentSchema.default('local'),
  auth: ApiAuthSchema.default({ type: 'none' }),
  access: ApiAccessSchema.default({
    methods: [...SAFE_METHODS],
    confirmMethods: [],
    allowPaths: ['/**'],
    denyPaths: [],
    timeoutMs: API_LIMITS.timeoutMs.default,
    maxResponseBytes: API_LIMITS.maxResponseBytes.default,
    allowSelfSignedOnLoopback: false,
  }),
  openapi: OpenApiSourceSchema.default({ source: 'auto' }),
  /** Path checked by *Test* (default: the base URL). */
  healthPath: z.string().max(500).optional(),
  agents: AgentExposureSchema.default({ exposed: true, shareWithRelated: false }),
});
export type ApiResource = z.infer<typeof ApiResourceSchema>;

export const LinkResourceSchema = z.looseObject({
  id: ResourceIdSchema,
  title: z.string().trim().min(1).max(200),
  url: z.string().max(2000),
});
export type LinkResource = z.infer<typeof LinkResourceSchema>;

export const LogResourceSchema = z.looseObject({
  id: ResourceIdSchema,
  name: ResourceNameSchema,
  /** A file, or a glob in the file name (`C:\logs\api-*.log`: the newest match); relative to the project root. */
  path: z.string().min(1).max(1000),
  agents: AgentExposureSchema.default({ exposed: true, shareWithRelated: false }),
});
export type LogResource = z.infer<typeof LogResourceSchema>;

export const INSTRUCTIONS_FILES = ['none', 'AGENTS.md', 'CLAUDE.md'] as const;

export const AgentBriefSettingsSchema = z.looseObject({
  /** Claude Code sessions get a short brief about the resources with their first prompt (Claude Code Bridge). */
  sessionHook: z.boolean().default(true),
  /** A managed block in this file of the repository (written only after the user asks). */
  instructionsFile: z.enum(INSTRUCTIONS_FILES).default('none'),
});
export type AgentBriefSettings = z.infer<typeof AgentBriefSettingsSchema>;

export const ProjectResourcesSchema = z.looseObject({
  databases: z.array(DatabaseResourceSchema).max(100).default([]),
  apis: z.array(ApiResourceSchema).max(100).default([]),
  links: z.array(LinkResourceSchema).max(100).default([]),
  logs: z.array(LogResourceSchema).max(100).default([]),
  relatedProjectIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  agentBrief: AgentBriefSettingsSchema.default({ sessionHook: true, instructionsFile: 'none' }),
});
export type ProjectResources = z.infer<typeof ProjectResourcesSchema>;

export const emptyResources = (): ProjectResources => ProjectResourcesSchema.parse({});

/** A new id for a resource. */
export function newResourceId(existing: Iterable<string>, prefix = 'r'): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) {
    const id = `${prefix}${Date.now().toString(36)}${i}`;
    if (!taken.has(id)) return id;
  }
}

// ── secrets ──

export const SECRET_KEY_PATTERN = /^(password|url|token|apiKey|header:[A-Za-z0-9!#$%&'*+.^_`|~-]{1,200})$/;
export const SecretKeySchema = z.string().regex(SECRET_KEY_PATTERN);

/** The secrets a database resource uses, by connection kind. */
export function databaseSecretKeys(db: Pick<DatabaseResource, 'connection' | 'engine'>): string[] {
  if (db.connection.kind === 'url') return ['url'];
  if (db.connection.kind === 'fields') return ['password'];
  return [];
}

/** The secrets an API resource uses, by auth type. */
export function apiSecretKeys(api: Pick<ApiResource, 'auth'>): string[] {
  switch (api.auth.type) {
    case 'bearer':
      return ['token'];
    case 'basic':
      return ['password'];
    case 'api-key':
      return ['apiKey'];
    case 'headers':
      return api.auth.names.map((n) => `header:${n}`);
    default:
      return [];
  }
}

/** `secrets:status` key: `<resourceId>/<secretKey>`. */
export const secretStatusKey = (resourceId: string, key: string): string => `${resourceId}/${key}`;

export const SecretChangeSchema = z.object({
  resourceId: ResourceIdSchema,
  key: SecretKeySchema,
  /** null removes the secret. */
  value: z.string().max(20_000).nullable(),
  /** Copies the secret of an import candidate instead (it never passes through the renderer). */
  importToken: z.string().max(200).optional(),
});
export type SecretChange = z.infer<typeof SecretChangeSchema>;

export const SecretsStatusSchema = z.object({
  /** `<resourceId>/<key>` of every stored secret. */
  stored: z.array(z.string()),
  /** Electron safeStorage backend; `basic_text` (Linux without a keyring) only obfuscates. */
  backend: z.string(),
  /** Secrets are encrypted with an OS key (false: only obfuscated, or encryption is unavailable). */
  encrypted: z.boolean(),
});
export type SecretsStatus = z.infer<typeof SecretsStatusSchema>;

// ── validation ──

const hasHost = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
};

/** A base URL an agent may call (http/https with a host, no credentials). */
export function isValidBaseUrl(url: string): boolean {
  if (!hasHost(url)) return false;
  const u = new URL(url);
  return u.username === '' && u.password === '';
}

/** Problems that block saving the resources (shown in the dialog). */
export function validateResources(r: ProjectResources): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const unique = (id: string, what: string) => {
    if (ids.has(id)) problems.push(`${what}: the id ${id} is used twice.`);
    ids.add(id);
  };
  const names = new Set<string>();
  for (const db of r.databases) {
    unique(db.id, db.name);
    const key = db.name.toLowerCase();
    if (names.has(key)) problems.push(`Two resources are named "${db.name}"; agents choose them by name.`);
    names.add(key);
    if (db.environment === 'production' && db.access.mode === 'read-write')
      problems.push(`${db.name}: a production database can be read-only or ask before writes, not read-write.`);
    const info = ENGINE_INFO[db.engine];
    if (db.connection.kind === 'file' && !info.file) problems.push(`${db.name}: only SQLite uses a database file.`);
    if (info.file && db.connection.kind !== 'file' && db.connection.kind !== 'env-ref')
      problems.push(`${db.name}: choose the SQLite database file.`);
    if (db.connection.kind === 'fields' && !db.connection.host.trim())
      problems.push(`${db.name}: the host is missing.`);
  }
  for (const api of r.apis) {
    unique(api.id, api.name);
    const key = api.name.toLowerCase();
    if (names.has(key)) problems.push(`Two resources are named "${api.name}"; agents choose them by name.`);
    names.add(key);
    const url = typeof api.baseUrl === 'string' ? api.baseUrl : api.baseUrl.fallback;
    if (typeof api.baseUrl === 'string' && !isValidBaseUrl(api.baseUrl))
      problems.push(`${api.name}: the base URL must be an http(s) address without a user name or password.`);
    if (typeof api.baseUrl !== 'string' && url && !isValidBaseUrl(url))
      problems.push(`${api.name}: the fallback URL must be an http(s) address.`);
    if (api.environment === 'production' && api.access.methods.some((m) => !SAFE_METHODS.includes(m))) {
      const unconfirmed = api.access.methods.filter(
        (m) => !SAFE_METHODS.includes(m) && !api.access.confirmMethods.includes(m),
      );
      if (unconfirmed.length) problems.push(`${api.name}: on production, ${unconfirmed.join(', ')} must ask first.`);
    }
    if (api.auth.type === 'api-key' && !api.auth.name.trim()) problems.push(`${api.name}: the key's name is missing.`);
  }
  for (const log of r.logs) {
    unique(log.id, log.name);
    const key = log.name.toLowerCase();
    if (names.has(key)) problems.push(`Two resources are named "${log.name}"; agents choose them by name.`);
    names.add(key);
  }
  for (const link of r.links) {
    unique(link.id, link.title);
    if (!hasHost(link.url)) problems.push(`${link.title}: the link must be an http(s) address.`);
  }
  return problems;
}

// ── test results, import ──

export const ConnectionErrorKindSchema = z.enum([
  'auth',
  'unreachable',
  'tls',
  'database',
  'timeout',
  'config',
  'unsupported',
  'http',
  'other',
]);
export type ConnectionErrorKind = z.infer<typeof ConnectionErrorKindSchema>;

export const ResourceTestResultSchema = z.object({
  ok: z.boolean(),
  /** "PostgreSQL 17.2", "HTTP 200 OK". */
  serverVersion: z.string().optional(),
  latencyMs: z.number().optional(),
  error: z.object({ kind: ConnectionErrorKindSchema, message: z.string() }).optional(),
  /** Extra facts ("OpenAPI: 24 operations"). */
  details: z.array(z.string()).optional(),
});
export type ResourceTestResult = z.infer<typeof ResourceTestResultSchema>;

export const ImportCandidateSchema = z.object({
  /** Where it was found, relative to the project root ("appsettings.Development.json: ConnectionStrings.Default"). */
  source: z.string(),
  file: z.string(),
  engine: DatabaseEngineSchema,
  name: z.string(),
  /** Connection fields without the secret. */
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  options: z.record(z.string(), z.string()).optional(),
  /** A file database (SQLite). */
  path: z.string().optional(),
  tls: DatabaseTlsSchema.partial().optional(),
  /** The candidate has a password or is a whole URL (a secret). */
  hasSecret: z.boolean(),
  /** The value can be referenced in place (`env-ref`: an env file and variable). */
  reference: z.object({ file: z.string(), variable: z.string() }).optional(),
  /** Id to pass back to import it as a copy (the host keeps the secret for a short time). */
  token: z.string(),
});
export type ImportCandidate = z.infer<typeof ImportCandidateSchema>;

// ── briefs for agents ──

export interface BriefResource {
  kind: 'database' | 'api' | 'log';
  name: string;
  /** From a related project. */
  project?: string;
  engine?: DatabaseEngine;
  environment?: ResourceEnvironment;
  mode?: AccessMode;
  methods?: HttpMethod[];
  url?: string;
  description?: string;
}

const describeMode = (mode: AccessMode | undefined): string =>
  mode === 'read-write' ? 'read-write' : mode === 'confirm-writes' ? 'writes ask the user' : 'read-only';

function briefLine(r: BriefResource): string {
  const from = r.project ? ` of ${r.project}` : '';
  const note = r.description ? ` — ${r.description.replace(/\s+/g, ' ').slice(0, 300)}` : '';
  if (r.kind === 'database') {
    const engine = r.engine ? ENGINE_INFO[r.engine].label : 'database';
    const tools =
      r.engine === 'mongodb'
        ? 'oxy_db_schema / oxy_mongo'
        : r.engine === 'redis'
          ? 'oxy_db_schema / oxy_redis'
          : 'oxy_db_schema / oxy_db_query';
    return `- database "${r.name}"${from} (${engine}, ${r.environment ?? 'local'}, ${describeMode(r.mode)}) — use ${tools}${note}`;
  }
  if (r.kind === 'api') {
    const where = r.url ? `${r.url}, ` : '';
    return `- API "${r.name}"${from} (${where}${r.environment ?? 'local'}, methods: ${(r.methods ?? []).join(', ') || 'none'}) — use oxy_api_describe / oxy_api_request${note}`;
  }
  return `- log "${r.name}"${from} — use oxy_logs_tail${note}`;
}

/** The text agents get about a project's resources (MCP instructions, the session brief, AGENTS.md). */
export function buildAgentBrief(projectName: string, resources: BriefResource[]): string {
  if (resources.length === 0) return '';
  return [
    `Project "${projectName}" has resources available through Oxytocin's MCP server (\`oxytocin\`):`,
    ...resources.map(briefLine),
    'Use these tools instead of looking for credentials or connecting yourself: Oxytocin adds the credentials and enforces what the user allowed (read-only, asking before writes). Call oxy_project_resources for details and oxy_db_schema before writing queries.',
  ].join('\n');
}

export const MANAGED_BLOCK_START = '<!-- oxytocin:resources:start -->';
export const MANAGED_BLOCK_END = '<!-- oxytocin:resources:end -->';

/** Replaces (or appends) the managed block of an instructions file; an empty `body` removes the block. */
export function applyManagedBlock(text: string, body: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = body
    ? [
        MANAGED_BLOCK_START,
        '<!-- Written by Oxytocin (Project settings → Agents). Edits inside this block are replaced. -->',
        ...body.split('\n'),
        MANAGED_BLOCK_END,
      ].join(eol)
    : '';
  const start = text.indexOf(MANAGED_BLOCK_START);
  const end = start >= 0 ? text.indexOf(MANAGED_BLOCK_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const before = text.slice(0, start);
    let after = text.slice(end + MANAGED_BLOCK_END.length);
    if (!block) {
      after = after.replace(/^\r?\n/, '');
      return `${before.replace(/(\r?\n){2,}$/, eol)}${after}`.replace(/^\r?\n$/, '');
    }
    return `${before}${block}${after}`;
  }
  if (!block) return text;
  if (!text.trim()) return `${block}${eol}`;
  return `${text.replace(/\s*$/, '')}${eol}${eol}${block}${eol}`;
}

// ── shared config in the repository ──

/** `.oxytocin/project.json`: resources without secrets, shared through the repository. */
export const SharedProjectConfigSchema = z.looseObject({
  version: z.literal(1),
  resources: z.looseObject({
    databases: z.array(DatabaseResourceSchema).max(100).default([]),
    apis: z.array(ApiResourceSchema).max(100).default([]),
    links: z.array(LinkResourceSchema).max(100).default([]),
    logs: z.array(LogResourceSchema).max(100).default([]),
  }),
});
export type SharedProjectConfig = z.infer<typeof SharedProjectConfigSchema>;

export const SHARED_CONFIG_PATH = '.oxytocin/project.json';

/** The shareable part of the resources: no production hosts or URLs (they stay local). */
export function sharedConfigOf(r: ProjectResources): SharedProjectConfig {
  const databases = r.databases
    .filter((d) => d.environment !== 'production')
    .map((d) => ({ ...d, agents: { ...d.agents, shareWithRelated: false } }));
  const apis = r.apis.filter((a) => a.environment !== 'production');
  return { version: 1, resources: { databases, apis, links: r.links, logs: r.logs } };
}

export const RepositoryConfigNoticeSchema = z.object({
  projectId: z.string(),
  hash: z.string(),
  databases: z.number(),
  apis: z.number(),
  links: z.number(),
  logs: z.number(),
});
export type RepositoryConfigNotice = z.infer<typeof RepositoryConfigNoticeSchema>;
