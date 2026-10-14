import { z } from 'zod';
import {
  type DatabaseEngine,
  DatabaseEngineSchema,
  type DatabaseResource,
  DatabaseResourceSchema,
  DatabaseTlsSchema,
  DATABASE_ENGINES,
  DEFAULT_MASKING,
  DB_LIMITS,
  ENGINE_INFO,
  newResourceId,
  type ProjectResources,
  RESOURCE_ID_PATTERN,
  ResourceEnvironmentSchema,
} from './project-resources';

/**
 * Database servers: configured once in Settings → Database Servers (host, user, password, TLS), their databases
 * discovered or added by hand, and linked to projects as needed. A linked database is a project resource with a
 * `server` connection; access rules stay per project, the connection comes from the server when Oxytocin connects.
 * The password lives in the encrypted secret store under {@link SERVER_SECRET_SCOPE}.
 */

/** Engines a server can have (SQLite is a file, not a server). */
export const SERVER_ENGINES = DATABASE_ENGINES.filter((e) => !ENGINE_INFO[e].file);

/** The secret store's "project" of server passwords (project ids are 12 hex characters, so this never collides). */
export const SERVER_SECRET_SCOPE = 'database-servers';

/** A server name is part of linked database names (`FIRMA_1/WMS_DB`), so it has no slash. */
export const SERVER_NAME_PATTERN = /^[^/\\]{1,60}$/;

export const ServerDatabaseSchema = z.looseObject({
  name: z.string().trim().min(1).max(500),
  /** Told to agents with every linked copy of the database (each project can add its own notes). */
  description: z.string().max(2000).optional(),
});
export type ServerDatabase = z.infer<typeof ServerDatabaseSchema>;

export const DatabaseServerSchema = z.looseObject({
  id: z.string().regex(RESOURCE_ID_PATTERN),
  name: z.string().trim().min(1).max(60),
  engine: DatabaseEngineSchema,
  /** The environment linked databases start with (each project may change it). */
  environment: ResourceEnvironmentSchema.default('dev'),
  host: z.string().max(500).default(''),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().max(500).optional(),
  /** The database used to connect for discovery (`master`, `postgres`, an Oracle service name…). */
  database: z.string().max(500).optional(),
  /** Engine-specific options, as for a project database (`instanceName`, `domain`, `authSource`…). */
  options: z.record(z.string(), z.string().max(2000)).default({}),
  tls: DatabaseTlsSchema.optional(),
  /** The databases of this server that can be linked to projects. */
  databases: z.array(ServerDatabaseSchema).max(1000).default([]),
  /** When the databases were last discovered (ms). */
  discoveredAt: z.number().optional(),
});
export type DatabaseServer = z.infer<typeof DatabaseServerSchema>;

export const DatabaseServersSchema = z.array(DatabaseServerSchema).max(200);

/** The database a discovery connects to when the server names none. */
export function discoveryDatabase(engine: DatabaseEngine): string | undefined {
  switch (engine) {
    case 'postgresql':
      return 'postgres';
    case 'cockroachdb':
      return 'defaultdb';
    case 'sqlserver':
      return 'master';
    case 'clickhouse':
      return 'default';
    case 'mongodb':
      return 'admin';
    default:
      return undefined;
  }
}

const SYSTEM_DATABASES: Partial<Record<DatabaseEngine, string[]>> = {
  postgresql: ['postgres'],
  cockroachdb: ['system', 'postgres', 'defaultdb'],
  sqlserver: ['master', 'model', 'msdb', 'tempdb'],
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mariadb: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mongodb: ['admin', 'config', 'local'],
  clickhouse: ['system', 'information_schema', 'default'],
  oracle: ['CDB$ROOT', 'PDB$SEED'],
};

/** Databases of the engine itself (hidden in discovery results unless asked for). */
export const isSystemDatabase = (engine: DatabaseEngine, name: string): boolean =>
  (SYSTEM_DATABASES[engine] ?? []).some((s) => s.toLowerCase() === name.toLowerCase());

export function newServer(existing: readonly DatabaseServer[], engine: DatabaseEngine): DatabaseServer {
  const info = ENGINE_INFO[engine];
  const taken = new Set(existing.map((s) => s.name.toLowerCase()));
  let n = existing.length + 1;
  while (taken.has(`server_${n}`)) n++;
  return DatabaseServerSchema.parse({
    id: newResourceId(
      existing.map((s) => s.id),
      's',
    ),
    name: `SERVER_${n}`,
    engine,
    host: '',
    ...(info.defaultUser ? { user: info.defaultUser } : {}),
    ...(engine === 'sqlserver' ? { tls: { mode: 'prefer', trustServerCertificate: true } } : {}),
  });
}

/** Problems that block saving the servers. */
export function validateServers(servers: readonly DatabaseServer[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const s of servers) {
    if (ids.has(s.id)) problems.push(`${s.name}: the id ${s.id} is used twice.`);
    ids.add(s.id);
    const key = s.name.trim().toLowerCase();
    if (names.has(key)) problems.push(`Two servers are named "${s.name}".`);
    names.add(key);
    if (!SERVER_NAME_PATTERN.test(s.name.trim())) problems.push(`${s.name}: a server name cannot contain / or \\.`);
    if (ENGINE_INFO[s.engine].file) problems.push(`${s.name}: SQLite databases are files; add them to a project.`);
    if (!s.host.trim()) problems.push(`${s.name}: the host is missing.`);
    if (s.engine === 'oracle' && !s.database?.trim())
      problems.push(`${s.name}: enter the service name Oxytocin connects to.`);
    const dbs = new Set<string>();
    for (const d of s.databases) {
      if (dbs.has(d.name.toLowerCase())) problems.push(`${s.name}: the database ${d.name} is listed twice.`);
      dbs.add(d.name.toLowerCase());
    }
  }
  return problems;
}

/** The name a linked database gets in a project: `<server>/<database>` (agents pick databases by name). */
export const linkedDatabaseName = (server: Pick<DatabaseServer, 'name'>, database: string): string =>
  `${server.name}/${database}`.slice(0, 100);

/** A project resource for a database of a server (read-only by default, like every new database). */
export function linkedDatabase(
  resources: Pick<ProjectResources, 'databases' | 'apis' | 'logs' | 'links'>,
  server: DatabaseServer,
  database: string,
): DatabaseResource {
  const id = newResourceId(
    [...resources.databases, ...resources.apis, ...resources.logs, ...resources.links].map((r) => r.id),
    'd',
  );
  return DatabaseResourceSchema.parse({
    id,
    name: linkedDatabaseName(server, database),
    engine: server.engine,
    environment: server.environment,
    connection: { kind: 'server', serverId: server.id, database },
    access: {
      mode: 'read-only',
      allowUserFunctions: false,
      maxRows: DB_LIMITS.maxRows.default,
      timeoutMs: DB_LIMITS.timeoutMs.default,
      maxResultBytes: DB_LIMITS.maxResultBytes.default,
    },
    masking: DEFAULT_MASKING,
    agents: {
      exposed: true,
      shareWithRelated: false,
      ...(server.databases.find((d) => d.name === database)?.description
        ? { description: server.databases.find((d) => d.name === database)!.description }
        : {}),
    },
  });
}

/**
 * A linked database as the drivers see it: the server's host, user, options and TLS with the linked database.
 * Other resources are returned as they are.
 */
export function materializeLinked(resource: DatabaseResource, server: DatabaseServer): DatabaseResource {
  const c = resource.connection;
  if (c.kind !== 'server') return resource;
  const redis = server.engine === 'redis';
  return {
    ...resource,
    engine: server.engine,
    connection: {
      kind: 'fields',
      host: server.host,
      ...(server.port ? { port: server.port } : {}),
      ...(server.user ? { user: server.user } : {}),
      ...(redis ? {} : { database: c.database }),
      options: { ...server.options, ...(redis ? { db: c.database } : {}) },
    },
    ...(server.tls ? { tls: server.tls } : {}),
  };
}

/** The server itself as a resource (for discovery): connected to its discovery database. */
export function serverAsResource(server: DatabaseServer): DatabaseResource {
  const database = server.database?.trim() || discoveryDatabase(server.engine);
  return DatabaseResourceSchema.parse({
    id: server.id,
    name: server.name,
    engine: server.engine,
    environment: server.environment,
    connection: {
      kind: 'fields',
      host: server.host,
      ...(server.port ? { port: server.port } : {}),
      ...(server.user ? { user: server.user } : {}),
      ...(database && server.engine !== 'redis' ? { database } : {}),
      options: server.options,
    },
    ...(server.tls ? { tls: server.tls } : {}),
    access: {
      mode: 'read-only',
      allowUserFunctions: false,
      maxRows: DB_LIMITS.maxRows.max,
      timeoutMs: 20_000,
      maxResultBytes: DB_LIMITS.maxResultBytes.default,
    },
  });
}

// ── discovery ──

export const DiscoveredDatabaseSchema = z.object({ name: z.string(), system: z.boolean() });
export type DiscoveredDatabase = z.infer<typeof DiscoveredDatabaseSchema>;

export const DiscoveryResultSchema = z.object({
  ok: z.boolean(),
  serverVersion: z.string().optional(),
  latencyMs: z.number().optional(),
  databases: z.array(DiscoveredDatabaseSchema).default([]),
  /** Discovery found only part of the picture (e.g. Oracle without access to v$pdbs). */
  note: z.string().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

/** Merges discovered names into a server's list: new ones are added, nothing is removed. */
export function addDatabases(server: DatabaseServer, names: readonly string[]): DatabaseServer {
  const have = new Set(server.databases.map((d) => d.name.toLowerCase()));
  const added = names.filter((n) => n.trim() && !have.has(n.toLowerCase()));
  return { ...server, databases: [...server.databases, ...added.map((name) => ({ name: name.trim() }))] };
}
