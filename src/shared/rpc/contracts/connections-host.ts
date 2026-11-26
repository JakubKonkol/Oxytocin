import type {
  ApiResource,
  DatabaseResource,
  ImportCandidate,
  LogResource,
  ResourceTestResult,
} from '../../domain/project-resources';
import type { DiscoveryResult } from '../../domain/database-servers';
import type { HostBaseEvents, HostBaseMethods } from './host-base';

/** A database resource as main hands it to the Connections Host: with its secrets and project root. */
export interface ResolvedDatabase {
  /** `<projectId>/<resourceId>`: pools of a resource are closed by this key. */
  key: string;
  resource: DatabaseResource;
  projectRoot: string;
  /** `password` or `url`, decrypted by main for this call only. */
  secrets: Record<string, string>;
  /** Hash of everything a pool depends on; a new value opens a new pool. */
  fingerprint: string;
}

export interface ResolvedApi {
  key: string;
  resource: ApiResource;
  projectRoot: string;
  /** The base URL (resolved from a run profile by main when needed). */
  baseUrl: string;
  secrets: Record<string, string>;
}

/** What the guard found out about a statement or operation. */
export interface Classification {
  /** `read` passes in read-only mode. */
  kind: 'read' | 'write' | 'ddl' | 'dcl' | 'unknown';
  /** e.g. SELECT, INSERT, DROP TABLE, find, updateMany, HGETALL. */
  statement: string;
  tables: string[];
  /** Why it is not a plain read (shown to the agent and in the confirmation). */
  reasons: string[];
  /** Asks the user even in read-write mode (DROP, TRUNCATE, DELETE without WHERE, …). */
  dangerous: string[];
}

export type GuardOutcome =
  | { status: 'done'; text: string; classification: Classification }
  | { status: 'rejected'; message: string; classification: Classification }
  /** The call needs the user's approval; main asks and calls again with `approved: true`. */
  | { status: 'needs-approval'; message: string; classification: Classification; preview: string };

/**
 * Where a result too large for the reply may be saved: the root of the calling agent's project (the file goes to
 * its `.oxy/results`). Without it, large results are cut as before. `saveToFile` saves the result even when small.
 */
export interface ResultFileOptions {
  resultsRoot?: string;
  saveToFile?: boolean;
}

export interface DbQueryRequest extends ResolvedDatabase, ResultFileOptions {
  query: string;
  params?: unknown[];
  maxRows?: number;
  format?: 'markdown' | 'json';
  approved?: boolean;
}

export interface MongoRequest extends ResolvedDatabase, ResultFileOptions {
  collection: string;
  operation: string;
  args: Record<string, unknown>;
  maxRows?: number;
  approved?: boolean;
}

export interface RedisRequest extends ResolvedDatabase, ResultFileOptions {
  command: string;
  args: string[];
  approved?: boolean;
}

export interface ApiRequest extends ResolvedApi, ResultFileOptions {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  approved?: boolean;
}

export type ConnectionsHostMethods = HostBaseMethods & {
  'db:test': (o: ResolvedDatabase) => ResourceTestResult;
  /** Connects to a database server and lists its databases (Settings → Database Servers). */
  'db:discover': (o: ResolvedDatabase) => DiscoveryResult;
  'db:schema': (o: ResolvedDatabase & { schema?: string; table?: string }) => { text: string };
  'db:query': (o: DbQueryRequest) => GuardOutcome;
  'db:mongo': (o: MongoRequest) => GuardOutcome;
  'db:redis': (o: RedisRequest) => GuardOutcome;
  /** Closes the pools whose key is one of `keys` (a resource changed or was removed); none: every pool. */
  'db:close': (o: { keys?: string[] }) => void;
  'api:test': (o: ResolvedApi) => ResourceTestResult;
  'api:describe': (o: ResolvedApi & { filter?: string; operation?: string }) => { text: string };
  'api:request': (o: ApiRequest) => GuardOutcome;
  'logs:tail': (o: { resource: LogResource; projectRoot: string; lines: number; grep?: string }) => { text: string };
  /** Connection strings found in a project's files (no secrets in the result). */
  'import:scan': (o: { root: string }) => ImportCandidate[];
  /** The secret of a candidate (for "Copy into Oxytocin"; main stores it, it never reaches the renderer). */
  'import:secret': (o: { root: string; token: string }) => { value: string | null };
};

export type ConnectionsHostEvents = HostBaseEvents;
