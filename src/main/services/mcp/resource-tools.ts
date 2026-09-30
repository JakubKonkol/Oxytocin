import { ENGINE_INFO, isSqlEngine, type ApiResource } from '@shared/domain/project-resources';
import type { ConnectionsHostMethods, GuardOutcome } from '@shared/rpc/contracts/connections-host';
import { NO_PROJECT_MESSAGE, type ResolvedCaller } from './caller-context';
import type { CoreTool } from './core-tools';
import type { Accessible, ResourceProject, ResourceService } from '../resources/resource-service';
import { scalarText } from '@shared/utils/text';

type HostCall = <M extends Extract<keyof ConnectionsHostMethods, string>>(
  method: M,
  params: Parameters<ConnectionsHostMethods[M]>[0],
  opts?: { timeoutMs?: number },
) => Promise<Awaited<ReturnType<ConnectionsHostMethods[M]>>>;

/** Which resources must exist for a tool to be listed. */
export type ResourceToolNeed = 'any' | 'sql' | 'database' | 'mongodb' | 'redis' | 'api' | 'log';

export interface ResourceTool extends CoreTool {
  needs: ResourceToolNeed;
  /** Kept in the call log (the query, the request line): the audit trail of resource tools. */
  logDetail(args: Record<string, unknown>): string | undefined;
}

export interface ResourceToolsDeps {
  resources: Pick<ResourceService, 'accessible' | 'find' | 'links' | 'resolveDatabase' | 'resolveApi' | 'get'>;
  host: HostCall;
  projects(): ResourceProject[];
  /** The base URL of an API (a run profile's URL is resolved through the Project Runner). */
  baseUrl(api: ApiResource, project: ResourceProject): Promise<string>;
  /** Asks the user to approve a write; null when nobody answered in time. */
  confirm(o: {
    title: string;
    description: string;
    code: string;
    details: string[];
    signal: AbortSignal;
  }): Promise<boolean | null>;
}

const PROJECT_ARGS = {
  cwd: {
    type: 'string',
    description: 'Your current working directory; selects the Oxytocin project that contains it.',
  },
  project: { type: 'string', description: 'Project name, id or root folder (instead of cwd).' },
};

const DATABASE_ARG = {
  database: {
    type: 'string',
    description:
      'Database name as oxy_project_resources lists it ("project/name" for a related project). May be left out when the project has only one.',
  },
};

const APPROVAL_WAIT_MS = 5 * 60_000;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const cut = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

function projectOf(deps: ResourceToolsDeps, caller: ResolvedCaller): ResourceProject {
  const id = caller.context.projectId;
  const project = id ? deps.projects().find((p) => p.id === id) : undefined;
  if (!project) throw new Error(caller.projectError ?? NO_PROJECT_MESSAGE);
  return project;
}

const who = (caller: ResolvedCaller) => (caller.label ? `An agent in ${caller.label}` : 'An agent');

/** Runs a guarded call; asks the user when the bridge says so and runs it again approved. */
async function guarded(
  deps: ResourceToolsDeps,
  o: { name: string; caller: ResolvedCaller; signal: AbortSignal; action: string },
  run: (approved: boolean) => Promise<GuardOutcome>,
): Promise<string> {
  const first = await run(false);
  if (first.status === 'done') return first.text;
  if (first.status === 'rejected') throw new Error(first.message);
  const c = first.classification;
  const details = [
    `Kind: ${c.kind}${c.tables.length ? ` · ${c.tables.join(', ')}` : ''}`,
    ...c.reasons.map((r) => `Why: ${r}`),
    ...c.dangerous.filter((d) => !c.reasons.includes(d)).map((d) => `Warning: ${d}`),
  ];
  const answer = await deps.confirm({
    title: `Allow ${c.statement} on ${o.name}?`,
    description: `${who(o.caller)} wants to ${o.action} ${o.name}. ${first.message}`,
    code: first.preview,
    details,
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(APPROVAL_WAIT_MS)]),
  });
  if (answer !== true)
    throw new Error(
      answer === false
        ? `The user denied this ${c.statement} on ${o.name}. Do not retry it; ask the user how to proceed.`
        : `This ${c.statement} on ${o.name} needs the user's approval, and nobody answered in time.`,
    );
  const second = await run(true);
  if (second.status === 'done') return second.text;
  throw new Error(second.message);
}

function describeAccessible(a: Accessible, url: string | undefined) {
  const from = a.own ? {} : { sharedBy: a.project.name };
  const description = a.resource.agents.description ? { note: a.resource.agents.description } : {};
  if (a.kind === 'database') {
    const info = ENGINE_INFO[a.resource.engine];
    const tools =
      info.family === 'mongodb'
        ? 'oxy_db_schema, oxy_mongo'
        : info.family === 'redis'
          ? 'oxy_db_schema, oxy_redis'
          : 'oxy_db_schema, oxy_db_query';
    return {
      name: a.own ? a.resource.name : `${a.project.name}/${a.resource.name}`,
      engine: info.label,
      environment: a.resource.environment,
      access:
        a.resource.access.mode === 'read-only'
          ? 'read-only'
          : a.resource.access.mode === 'confirm-writes'
            ? 'reads; writes ask the user'
            : 'read-write (DROP, TRUNCATE and UPDATE/DELETE without WHERE ask the user)',
      maxRows: a.resource.access.maxRows,
      tools,
      ...from,
      ...description,
    };
  }
  if (a.kind === 'api')
    return {
      name: a.own ? a.resource.name : `${a.project.name}/${a.resource.name}`,
      ...(url && a.resource.environment !== 'production' ? { baseUrl: url } : {}),
      environment: a.resource.environment,
      methods: a.resource.access.methods,
      ...(a.resource.access.confirmMethods.length ? { methodsAskingTheUser: a.resource.access.confirmMethods } : {}),
      paths: a.resource.access.allowPaths,
      ...(a.resource.access.denyPaths.length ? { blockedPaths: a.resource.access.denyPaths } : {}),
      openApi: a.resource.openapi.source !== 'off',
      tools: 'oxy_api_describe, oxy_api_request',
      ...from,
      ...description,
    };
  return {
    name: a.own ? a.resource.name : `${a.project.name}/${a.resource.name}`,
    tools: 'oxy_logs_tail',
    ...from,
    ...description,
  };
}

/** Oxytocin's bridge to the project's databases, APIs and logs (Plan 02), as core MCP tools. */
export function buildResourceTools(deps: ResourceToolsDeps): ResourceTool[] {
  const database = (caller: ResolvedCaller, args: Record<string, unknown>) =>
    deps.resources.find(projectOf(deps, caller).id, 'database', args['database']);
  const resolvedDb = (a: Extract<Accessible, { kind: 'database' }>) =>
    deps.resources.resolveDatabase(a.project, a.resource);
  const hostTimeout = (ms: number) => ms + 30_000;

  return [
    {
      needs: 'any',
      definition: {
        name: 'oxy_project_resources',
        title: 'List project resources',
        description:
          "Lists the databases, HTTP APIs, log files and links of your Oxytocin project (plus resources related projects share): name, engine or base URL, environment, what agents may do (read-only, writes ask the user, read-write) and the user's notes. Credentials are never shown: Oxytocin adds them when you use oxy_db_query, oxy_mongo, oxy_redis, oxy_api_request or oxy_logs_tail. Call it first when a task involves the project's data, API or logs, instead of looking for connection strings.",
        inputSchema: { type: 'object', properties: { ...PROJECT_ARGS } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      logDetail: () => undefined,
      run: async ({ caller }) => {
        const project = projectOf(deps, caller);
        const accessible = deps.resources.accessible(project.id);
        const items = await Promise.all(
          accessible.map(async (a) => {
            const url = a.kind === 'api' ? await deps.baseUrl(a.resource, a.project).catch(() => undefined) : undefined;
            return { kind: a.kind, ...describeAccessible(a, url) };
          }),
        );
        const links = deps.resources.links(project.id);
        const related = deps.resources
          .get(project.id)
          .relatedProjectIds.map((id) => deps.projects().find((p) => p.id === id))
          .filter((p): p is ResourceProject => !!p)
          .map((p) => ({ name: p.name, root: p.rootPath }));
        const body = {
          project: project.name,
          databases: items.filter((i) => i.kind === 'database').map(({ kind: _k, ...rest }) => rest),
          apis: items.filter((i) => i.kind === 'api').map(({ kind: _k, ...rest }) => rest),
          logs: items.filter((i) => i.kind === 'log').map(({ kind: _k, ...rest }) => rest),
          ...(links.length ? { links: links.map((l) => ({ title: l.title, url: l.url })) } : {}),
          ...(related.length ? { relatedProjects: related } : {}),
        };
        if (!accessible.length && !links.length)
          return `Project ${project.name} has no resources for agents. The user adds databases and APIs in Project settings (right-click the project).`;
        return `${JSON.stringify(body, null, 2)}\n\nThe bridge is the safe path, not a sandbox: use these tools rather than connecting directly with credentials from the project's files.`;
      },
    },
    {
      needs: 'database',
      definition: {
        name: 'oxy_db_schema',
        title: 'Database schema',
        description:
          'Shows the structure of a project database. Without `table`: its schemas and tables/views (MongoDB: collections; Redis: keyspace and key patterns). With `table`: columns (type, nullable, default), primary and foreign keys and indexes (MongoDB: indexes and the field shape of sampled documents, secret fields masked). With only `schema`: every table of that schema with its columns. Call it before writing queries. Cached for 60 s.',
        inputSchema: {
          type: 'object',
          properties: {
            ...DATABASE_ARG,
            schema: {
              type: 'string',
              description: 'Schema (PostgreSQL, SQL Server, Oracle owner) or database (MySQL, ClickHouse).',
            },
            table: { type: 'string', description: 'A table, view or collection.' },
            ...PROJECT_ARGS,
          },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        timeoutMs: 360_000,
      },
      logDetail: (args) =>
        [str(args['database']), str(args['schema']), str(args['table'])].filter(Boolean).join(' · ') || undefined,
      run: async ({ args, caller }) => {
        const a = database(caller, args);
        const r = await deps.host(
          'db:schema',
          {
            ...resolvedDb(a),
            ...(str(args['schema']) ? { schema: str(args['schema'])! } : {}),
            ...(str(args['table']) ? { table: str(args['table'])! } : {}),
          },
          { timeoutMs: hostTimeout(a.resource.access.timeoutMs) },
        );
        return `${a.resource.name} (${ENGINE_INFO[a.resource.engine].label}, ${a.resource.access.mode}):\n${r.text}`;
      },
    },
    {
      needs: 'sql',
      definition: {
        name: 'oxy_db_query',
        title: 'Query a database',
        description:
          'Runs one SQL statement on a project database (PostgreSQL, CockroachDB, SQL Server, MySQL, MariaDB, SQLite, ClickHouse, Oracle) through Oxytocin, which adds the credentials and enforces the user\'s rules. Read-only databases accept only plain reads: SELECT, WITH … SELECT, SHOW, DESCRIBE, EXPLAIN without ANALYZE — one statement, built-in functions, no SELECT INTO or FOR UPDATE. Databases that ask before writes show the user every other statement for approval; read-write databases still ask before DROP, TRUNCATE and UPDATE/DELETE without WHERE. Pass values in `params` (bound, never interpolated) with the engine\'s placeholders: $1 (PostgreSQL), ? (MySQL, MariaDB, SQLite), @p1 (SQL Server), :1 (Oracle), {p1:String} (ClickHouse). Results are capped (a Markdown table, or JSON with format "json"), say how many rows exist and mask secret columns (***). A refusal explains why; rewrite the query instead of retrying it.',
        inputSchema: {
          type: 'object',
          properties: {
            ...DATABASE_ARG,
            query: { type: 'string', description: 'One SQL statement.' },
            params: { type: 'array', description: 'Values for the placeholders, in order.', items: {} },
            maxRows: { type: 'number', description: 'Rows to return (capped by the database setting, default 200).' },
            format: { type: 'string', enum: ['markdown', 'json'], description: 'Default: markdown.' },
            ...PROJECT_ARGS,
          },
          required: ['query'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        timeoutMs: 600_000,
      },
      logDetail: (args) =>
        `${str(args['database']) ? `${str(args['database'])}: ` : ''}${cut(str(args['query']) ?? '')}`,
      run: async ({ args, caller, signal }) => {
        const a = database(caller, args);
        if (!isSqlEngine(a.resource.engine))
          throw new Error(
            `${a.resource.name} is ${ENGINE_INFO[a.resource.engine].label}: use ${a.resource.engine === 'mongodb' ? 'oxy_mongo' : 'oxy_redis'}.`,
          );
        const query = str(args['query']);
        if (!query?.trim()) throw new Error('Pass `query` (one SQL statement).');
        const params = Array.isArray(args['params']) ? args['params'] : undefined;
        const maxRows = typeof args['maxRows'] === 'number' ? args['maxRows'] : undefined;
        const format = args['format'] === 'json' ? ('json' as const) : ('markdown' as const);
        return guarded(deps, { name: a.resource.name, caller, signal, action: 'run this statement on' }, (approved) =>
          deps.host(
            'db:query',
            {
              ...resolvedDb(a),
              query,
              ...(params ? { params } : {}),
              ...(maxRows ? { maxRows } : {}),
              format,
              approved,
            },
            { timeoutMs: hostTimeout(a.resource.access.timeoutMs) },
          ),
        );
      },
    },
    {
      needs: 'mongodb',
      definition: {
        name: 'oxy_mongo',
        title: 'MongoDB operation',
        description:
          'Runs one operation on a collection of a project MongoDB database through Oxytocin (no free-form commands). Reads: find {filter, projection, sort, limit, skip}, findOne {filter, projection}, aggregate {pipeline}, countDocuments {filter}, estimatedDocumentCount, distinct {field, filter}, listIndexes, collStats. Writes follow the database\'s access mode (refused when read-only, the user approves them when it asks first): insertOne {document}, insertMany {documents}, updateOne/updateMany {filter, update, upsert}, replaceOne {filter, replacement}, deleteOne/deleteMany {filter}; deleteMany/updateMany with an empty filter always ask. Pipelines with $out, $merge, $function, $accumulator or $where are refused in read-only mode. Use Extended JSON for special values ({"$oid": "…"}, {"$date": "…"}). Results are capped and secret fields are masked.',
        inputSchema: {
          type: 'object',
          properties: {
            ...DATABASE_ARG,
            collection: { type: 'string' },
            operation: {
              type: 'string',
              description:
                'find, findOne, aggregate, countDocuments, estimatedDocumentCount, distinct, listIndexes, collStats, insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany.',
            },
            args: {
              type: 'object',
              description: 'The operation\'s arguments, e.g. {"filter": {"status": "open"}, "limit": 20}.',
            },
            ...PROJECT_ARGS,
          },
          required: ['collection', 'operation'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        timeoutMs: 600_000,
      },
      logDetail: (args) =>
        `${str(args['database']) ?? ''}${str(args['database']) ? ': ' : ''}${str(args['collection']) ?? '?'}.${str(args['operation']) ?? '?'} ${cut(JSON.stringify(args['args'] ?? {}), 300)}`,
      run: async ({ args, caller, signal }) => {
        const a = database(caller, args);
        if (a.resource.engine !== 'mongodb') throw new Error(`${a.resource.name} is not a MongoDB database.`);
        const collection = str(args['collection']);
        const operation = str(args['operation']);
        if (!collection || !operation) throw new Error('Pass `collection` and `operation`.');
        const opArgs =
          args['args'] && typeof args['args'] === 'object' && !Array.isArray(args['args'])
            ? (args['args'] as Record<string, unknown>)
            : {};
        return guarded(deps, { name: a.resource.name, caller, signal, action: `run ${operation} on` }, (approved) =>
          deps.host(
            'db:mongo',
            { ...resolvedDb(a), collection, operation, args: opArgs, approved },
            { timeoutMs: hostTimeout(a.resource.access.timeoutMs) },
          ),
        );
      },
    },
    {
      needs: 'redis',
      definition: {
        name: 'oxy_redis',
        title: 'Redis command',
        description:
          'Runs one Redis command on a project Redis/Valkey database through Oxytocin. Read commands are allowed (GET, MGET, HGETALL, HGET, LRANGE, SMEMBERS, ZRANGE, SCAN/HSCAN/SSCAN/ZSCAN, XRANGE, TTL, TYPE, EXISTS, INFO, DBSIZE, …); use SCAN with MATCH and COUNT instead of KEYS. Other commands follow the access mode; EVAL, FUNCTION, CONFIG, FLUSH*, SHUTDOWN, DEBUG, MODULE and SCRIPT are never offered. Values of secret keys and hash fields are masked.',
        inputSchema: {
          type: 'object',
          properties: {
            ...DATABASE_ARG,
            command: { type: 'string', description: 'e.g. HGETALL' },
            args: { type: 'array', items: { type: 'string' }, description: 'The arguments, e.g. ["session:42"].' },
            ...PROJECT_ARGS,
          },
          required: ['command'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        timeoutMs: 600_000,
      },
      logDetail: (args) =>
        `${str(args['database']) ?? ''}${str(args['database']) ? ': ' : ''}${str(args['command']) ?? ''} ${Array.isArray(args['args']) ? cut(args['args'].slice(0, 3).join(' '), 200) : ''}`.trim(),
      run: async ({ args, caller, signal }) => {
        const a = database(caller, args);
        if (a.resource.engine !== 'redis') throw new Error(`${a.resource.name} is not a Redis database.`);
        const command = str(args['command']);
        if (!command) throw new Error('Pass `command`.');
        const list = Array.isArray(args['args']) ? args['args'].map((x) => String(x as string)) : [];
        return guarded(
          deps,
          { name: a.resource.name, caller, signal, action: `run ${command.toUpperCase()} on` },
          (approved) =>
            deps.host(
              'db:redis',
              { ...resolvedDb(a), command, args: list, approved },
              { timeoutMs: hostTimeout(a.resource.access.timeoutMs) },
            ),
        );
      },
    },
    {
      needs: 'api',
      definition: {
        name: 'oxy_api_describe',
        title: 'Describe an API',
        description:
          'Summarizes a project API from its OpenAPI (Swagger) document: every operation\'s method, path, summary and operationId, marking the ones agents may not call. With `operation` (an operationId or "GET /users/{id}"): its parameters, request body and responses. `filter` narrows the list by path, tag or summary.',
        inputSchema: {
          type: 'object',
          properties: {
            api: {
              type: 'string',
              description: 'API name as oxy_project_resources lists it (may be left out when there is one).',
            },
            filter: { type: 'string' },
            operation: { type: 'string' },
            ...PROJECT_ARGS,
          },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        timeoutMs: 120_000,
      },
      logDetail: (args) =>
        [str(args['api']), str(args['operation']) ?? str(args['filter'])].filter(Boolean).join(' · ') || undefined,
      run: async ({ args, caller }) => {
        const a = deps.resources.find(projectOf(deps, caller).id, 'api', args['api']);
        const baseUrl = await deps.baseUrl(a.resource, a.project);
        const r = await deps.host(
          'api:describe',
          {
            ...deps.resources.resolveApi(a.project, a.resource, baseUrl),
            ...(str(args['filter']) ? { filter: str(args['filter'])! } : {}),
            ...(str(args['operation']) ? { operation: str(args['operation'])! } : {}),
          },
          { timeoutMs: 90_000 },
        );
        return r.text;
      },
    },
    {
      needs: 'api',
      definition: {
        name: 'oxy_api_request',
        title: 'Call an API',
        description:
          "Calls a project HTTP API through Oxytocin, which adds the authentication (never visible to you) and enforces the user's rules: allowed methods and paths, some methods asking the user first. `path` is a path on the API (e.g. /users/42?expand=orders), never a full URL: requests only go to the API's base URL, redirects only within it. Do not send Authorization or Cookie headers. The response shows the status, useful headers and the body (JSON pretty-printed, capped).",
        inputSchema: {
          type: 'object',
          properties: {
            api: {
              type: 'string',
              description: 'API name as oxy_project_resources lists it (may be left out when there is one).',
            },
            method: { type: 'string', enum: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string', description: 'Path on the API, e.g. /api/users/42.' },
            query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query parameters.' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { description: 'JSON body (an object or array), or a string sent as is.' },
            ...PROJECT_ARGS,
          },
          required: ['method', 'path'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        timeoutMs: 600_000,
      },
      logDetail: (args) =>
        `${str(args['api']) ? `${str(args['api'])}: ` : ''}${scalarText(args['method'], 'GET')} ${cut(str(args['path']) ?? '/', 300)}`,
      run: async ({ args, caller, signal }) => {
        const a = deps.resources.find(projectOf(deps, caller).id, 'api', args['api']);
        const baseUrl = await deps.baseUrl(a.resource, a.project);
        const method = scalarText(args['method'], 'GET').toUpperCase();
        const path = str(args['path']) ?? '/';
        const record = (v: unknown) =>
          v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x as string)]))
            : undefined;
        const query = record(args['query']);
        const headers = record(args['headers']);
        return guarded(
          deps,
          { name: a.resource.name, caller, signal, action: `call ${method} ${path} on` },
          (approved) =>
            deps.host(
              'api:request',
              {
                ...deps.resources.resolveApi(a.project, a.resource, baseUrl),
                method,
                path,
                ...(query ? { query } : {}),
                ...(headers ? { headers } : {}),
                ...(args['body'] !== undefined ? { body: args['body'] } : {}),
                approved,
              },
              { timeoutMs: hostTimeout(a.resource.access.timeoutMs) },
            ),
        );
      },
    },
    {
      needs: 'log',
      definition: {
        name: 'oxy_logs_tail',
        title: 'Read a log file',
        description:
          'Returns the last lines of a log file the user configured for the project (for a pattern like logs/api-*.log: the newest matching file), optionally only lines matching `grep` (a case-insensitive regular expression).',
        inputSchema: {
          type: 'object',
          properties: {
            log: {
              type: 'string',
              description: 'Log name as oxy_project_resources lists it (may be left out when there is one).',
            },
            lines: { type: 'number', description: 'Lines from the end (default 100, max 2000).' },
            grep: { type: 'string', description: 'Only lines matching this regular expression.' },
            ...PROJECT_ARGS,
          },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        timeoutMs: 60_000,
      },
      logDetail: (args) => [str(args['log']), str(args['grep'])].filter(Boolean).join(' · ') || undefined,
      run: async ({ args, caller }) => {
        const a = deps.resources.find(projectOf(deps, caller).id, 'log', args['log']);
        const r = await deps.host(
          'logs:tail',
          {
            resource: a.resource,
            projectRoot: a.project.rootPath,
            lines: typeof args['lines'] === 'number' ? args['lines'] : 100,
            ...(str(args['grep']) ? { grep: str(args['grep'])! } : {}),
          },
          { timeoutMs: 45_000 },
        );
        return r.text;
      },
    },
  ];
}
