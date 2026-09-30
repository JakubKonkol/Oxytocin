import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import type { DatabaseEngine } from '@shared/domain/project-resources';
import { engineFromHint, parseConnectionString, parseUrl, type ParsedConnection } from './connection-strings';
import { parseEnvFile } from './env-file';
import { scalarText } from '@shared/utils/text';

export interface Detected {
  source: string;
  name: string;
  connection: ParsedConnection;
  /** The secret (password or whole URL); it stays in the Connections Host. */
  secret?: string;
  /** A single env variable holding the whole connection: can be referenced in place. */
  reference?: { variable: string };
}

/** Engine hints from `prisma/schema.prisma`: `url = env("DATABASE_URL")` with its provider. */
export function prismaHints(content: string): Map<string, DatabaseEngine> {
  const out = new Map<string, DatabaseEngine>();
  const block = /datasource\s+\w+\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(content))) {
    const body = m[1]!;
    const provider = /provider\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const engine = provider ? engineFromHint(provider === 'sqlserver' ? 'mssql' : provider) : undefined;
    for (const env of body.matchAll(/(?:url|directUrl)\s*=\s*env\(\s*"([^"]+)"\s*\)/g))
      if (engine) out.set(env[1]!, engine);
  }
  return out;
}

const URL_VARIABLE =
  /^(DATABASE_URL|DB_URL|[A-Z0-9_]*_(DATABASE|DB)_URL|[A-Z0-9_]*DATABASE_URI|POSTGRES(QL)?_(PRISMA_)?URL(_NON_POOLING)?|PG_?URL|MYSQL_URL|MARIADB_URL|MONGO(DB)?_(URI|URL)|[A-Z0-9_]*_MONGO(DB)?_(URI|URL)|REDIS_URL|[A-Z0-9_]*_REDIS_URL|KV_URL|CLICKHOUSE_URL|SQLSERVER_URL|MSSQL_URL|ORACLE_URL|SQLITE_(URL|PATH)|[A-Z0-9_]*CONNECTION_?STRING[A-Z0-9_]*|ConnectionStrings__.+)$/i;

/** Password-less grouped variables (PGHOST, POSTGRES_*, MYSQL_*, Laravel DB_*). */
const GROUPS: {
  engine: DatabaseEngine | 'from-connection';
  host: string[];
  port: string[];
  user: string[];
  password: string[];
  database: string[];
}[] = [
  {
    engine: 'postgresql',
    host: ['PGHOST', 'POSTGRES_HOST'],
    port: ['PGPORT', 'POSTGRES_PORT'],
    user: ['PGUSER', 'POSTGRES_USER'],
    password: ['PGPASSWORD', 'POSTGRES_PASSWORD'],
    database: ['PGDATABASE', 'POSTGRES_DB', 'POSTGRES_DATABASE'],
  },
  {
    engine: 'mysql',
    host: ['MYSQL_HOST'],
    port: ['MYSQL_PORT'],
    user: ['MYSQL_USER'],
    password: ['MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD'],
    database: ['MYSQL_DATABASE', 'MYSQL_DB'],
  },
  {
    engine: 'from-connection',
    host: ['DB_HOST'],
    port: ['DB_PORT'],
    user: ['DB_USERNAME', 'DB_USER'],
    password: ['DB_PASSWORD', 'DB_PASS'],
    database: ['DB_DATABASE', 'DB_NAME'],
  },
];

const LARAVEL: Record<string, DatabaseEngine> = {
  pgsql: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlsrv: 'sqlserver',
  sqlite: 'sqlite',
};

const pick = (vars: Map<string, string>, keys: string[]) => {
  for (const k of keys) {
    const v = vars.get(k);
    if (v) return { key: k, value: v };
  }
  return undefined;
};

/** Spring-style `${VAR:default}` placeholders: the default, or undefined when there is none. */
const resolvePlaceholder = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const s = String(value).trim();
  if (!s.includes('${')) return s;
  const only = /^\$\{[^:}]+(?::([^}]*))?\}$/.exec(s);
  return only?.[1] ?? undefined;
};

function fromEnv(rel: string, content: string, hints: Map<string, DatabaseEngine>): Detected[] {
  const vars = parseEnvFile(content);
  const out: Detected[] = [];
  for (const [variable, value] of vars) {
    if (!value || !URL_VARIABLE.test(variable)) continue;
    const hint = hints.get(variable) ?? engineFromHint(variable);
    const connection = parseConnectionString(value, hint);
    if (!connection) continue;
    const whole = connection.keepAsUrl === true;
    out.push({
      source: `${rel}: ${variable}`,
      name: variable,
      connection,
      ...(connection.password !== undefined || whole
        ? {
            secret: whole ? value : connection.password,
          }
        : {}),
      reference: { variable },
    });
  }
  for (const group of GROUPS) {
    const host = pick(vars, group.host);
    if (!host) continue;
    let engine: DatabaseEngine | undefined = group.engine === 'from-connection' ? undefined : group.engine;
    if (group.engine === 'from-connection') {
      const conn = vars.get('DB_CONNECTION')?.toLowerCase();
      engine = conn ? LARAVEL[conn] : undefined;
      if (!engine) continue;
    }
    if (!engine) continue;
    const port = pick(vars, group.port);
    const user = pick(vars, group.user);
    const password = pick(vars, group.password);
    const database = pick(vars, group.database);
    if (engine === 'sqlite') {
      if (database)
        out.push({
          source: `${rel}: ${database.key}`,
          name: 'sqlite',
          connection: { engine, path: database.value, options: {} },
        });
      continue;
    }
    out.push({
      source: `${rel}: ${host.key}${user ? `, ${user.key}` : ''}${password ? `, ${password.key}` : ''}`,
      name: `${engine} (${host.key})`,
      connection: {
        engine,
        host: host.value,
        ...(port && Number(port.value) ? { port: Number(port.value) } : {}),
        ...(user ? { user: user.value } : {}),
        ...(database ? { database: database.value } : {}),
        options: {},
      },
      ...(password ? { secret: password.value } : {}),
    });
  }
  return out;
}

function fromAppSettings(rel: string, content: string): Detected[] {
  const errors: never[] = [];
  const json = parseJsonc(content, errors, { allowTrailingComma: true }) as unknown;
  const strings = json && typeof json === 'object' ? (json as Record<string, unknown>)['ConnectionStrings'] : undefined;
  if (!strings || typeof strings !== 'object') return [];
  const out: Detected[] = [];
  for (const [key, value] of Object.entries(strings as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const connection = parseConnectionString(value, engineFromHint(key));
    if (!connection) continue;
    const whole = connection.keepAsUrl === true;
    out.push({
      source: `${rel}: ConnectionStrings.${key}`,
      name: key,
      connection,
      ...(connection.password !== undefined || whole
        ? {
            secret: whole ? value : connection.password,
          }
        : {}),
    });
  }
  return out;
}

/** Spring Boot: `spring.datasource.*`, `spring.data.mongodb.uri`, `spring.data.redis.*` (flat keys). */
function fromSpring(rel: string, get: (key: string) => unknown): Detected[] {
  const out: Detected[] = [];
  const url = resolvePlaceholder(get('spring.datasource.url'));
  if (url) {
    const connection = parseConnectionString(url);
    if (connection) {
      const user = resolvePlaceholder(get('spring.datasource.username'));
      if (user && !connection.user) connection.user = user;
      const password = resolvePlaceholder(get('spring.datasource.password'));
      const secret = password ?? connection.password;
      if (password !== undefined) connection.password = password;
      out.push({
        source: `${rel}: spring.datasource`,
        name: 'datasource',
        connection,
        ...(secret !== undefined
          ? {
              secret,
            }
          : {}),
      });
    }
  }
  for (const key of ['spring.data.mongodb.uri', 'spring.mongodb.uri']) {
    const uri = resolvePlaceholder(get(key));
    const connection = uri ? parseUrl(uri) : null;
    if (uri && connection) out.push({ source: `${rel}: ${key}`, name: 'mongodb', connection, secret: uri });
  }
  for (const prefix of ['spring.data.redis', 'spring.redis']) {
    const url = resolvePlaceholder(get(`${prefix}.url`));
    const host = resolvePlaceholder(get(`${prefix}.host`));
    if (url) {
      const connection = parseUrl(url);
      if (connection)
        out.push({
          source: `${rel}: ${prefix}.url`,
          name: 'redis',
          connection,
          ...(connection.password !== undefined ? { secret: connection.password } : {}),
        });
    } else if (host) {
      const port = Number(resolvePlaceholder(get(`${prefix}.port`)));
      const password = resolvePlaceholder(get(`${prefix}.password`));
      out.push({
        source: `${rel}: ${prefix}`,
        name: 'redis',
        connection: { engine: 'redis', host, ...(port ? { port } : {}), options: {} },
        ...(password !== undefined ? { secret: password } : {}),
      });
    }
  }
  return out;
}

export function parseProperties(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    const rec = cur as Record<string, unknown>;
    cur = part in rec ? rec[part] : undefined;
  }
  return cur;
}

/** A YAML value by dotted key, following nested maps and flat dotted keys (`spring.datasource: {url: …}`). */
function yamlGet(doc: unknown, key: string): unknown {
  const parts = key.split('.');
  const walk = (node: unknown, i: number): unknown => {
    if (i === parts.length) return node;
    if (!node || typeof node !== 'object') return undefined;
    for (let j = parts.length; j > i; j--) {
      const k = parts.slice(i, j).join('.');
      const rec = node as Record<string, unknown>;
      if (k in rec) {
        const found = walk(rec[k], j);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(doc, 0);
}

const COMPOSE_IMAGES: [RegExp, DatabaseEngine][] = [
  [
    /(^|\/)(postgres|postgis\/postgis|timescale\/timescaledb[\w-]*|pgvector\/pgvector|bitnami\/postgresql)(:|$)/,
    'postgresql',
  ],
  [/(^|\/)cockroachdb\/cockroach(:|$)/, 'cockroachdb'],
  [/(^|\/)(mysql|bitnami\/mysql|mysql\/mysql-server)(:|$)/, 'mysql'],
  [/(^|\/)(mariadb|bitnami\/mariadb)(:|$)/, 'mariadb'],
  [/(^|\/)(mongo|mongodb\/mongodb-community-server|bitnami\/mongodb)(:|$)/, 'mongodb'],
  [/(^|\/)(redis|valkey\/valkey|bitnami\/redis|redis\/redis-stack[\w-]*|eqalpha\/keydb)(:|$)/, 'redis'],
  [/(^|\/)mssql\/server(:|$)|azure-sql-edge/, 'sqlserver'],
  [/(^|\/)clickhouse\/clickhouse-server(:|$)|yandex\/clickhouse-server/, 'clickhouse'],
  [/(^|\/)(gvenzl\/oracle-(free|xe)|container-registry\.oracle\.com\/database)/, 'oracle'],
];

function composeEnv(env: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(env)) {
    for (const item of env)
      if (typeof item === 'string') {
        const eq = item.indexOf('=');
        if (eq > 0) out.set(item.slice(0, eq), item.slice(eq + 1));
      }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, unknown>))
      if (v !== null && v !== undefined) out.set(k, scalarText(v));
  }
  for (const [k, v] of out) {
    const resolved = resolveComposeValue(v);
    if (resolved === undefined) out.delete(k);
    else out.set(k, resolved);
  }
  return out;
}

/** `${VAR:-default}` / `${VAR-default}` → the default; other interpolations are unknown. */
function resolveComposeValue(value: string): string | undefined {
  if (!value.includes('$')) return value;
  const m = /^\$\{[A-Za-z0-9_]+:?-([^}]*)\}$/.exec(value.trim());
  return m ? m[1] : undefined;
}

function hostPort(ports: unknown, container: number): number | undefined {
  if (!Array.isArray(ports)) return undefined;
  for (const p of ports) {
    if (typeof p === 'object' && p !== null) {
      const o = p as { target?: unknown; published?: unknown };
      if (Number(o.target) === container && o.published !== undefined) return Number(o.published);
      continue;
    }
    const parts = String(p as string)
      .replace(/\/(tcp|udp)$/, '')
      .split(':');
    const target = Number(parts.at(-1));
    const published = Number(parts.at(-2));
    if (target === container && published) return published;
  }
  return undefined;
}

const CONTAINER_PORTS: Partial<Record<DatabaseEngine, number>> = {
  postgresql: 5432,
  cockroachdb: 26257,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  sqlserver: 1433,
  clickhouse: 8123,
  oracle: 1521,
};

function fromCompose(rel: string, content: string): Detected[] {
  const doc = parseYaml(content) as unknown;
  const services = getPath(doc, ['services']);
  if (!services || typeof services !== 'object') return [];
  const out: Detected[] = [];
  for (const [service, def] of Object.entries(services as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const image = scalarText((def as { image?: unknown }).image).toLowerCase();
    const engine = COMPOSE_IMAGES.find(([re]) => re.test(image))?.[1];
    if (!engine) continue;
    const env = composeEnv((def as { environment?: unknown }).environment);
    const port = hostPort((def as { ports?: unknown }).ports, CONTAINER_PORTS[engine] ?? 0);
    let user: string | undefined;
    let password: string | undefined;
    let database: string | undefined;
    switch (engine) {
      case 'postgresql':
        user = env.get('POSTGRES_USER') ?? 'postgres';
        password = env.get('POSTGRES_PASSWORD');
        database = env.get('POSTGRES_DB') ?? user;
        break;
      case 'mysql':
      case 'mariadb': {
        const p = engine === 'mariadb' ? 'MARIADB' : 'MYSQL';
        user = env.get(`${p}_USER`) ?? env.get('MYSQL_USER');
        password = user ? (env.get(`${p}_PASSWORD`) ?? env.get('MYSQL_PASSWORD')) : undefined;
        if (!user) {
          user = 'root';
          password = env.get(`${p}_ROOT_PASSWORD`) ?? env.get('MYSQL_ROOT_PASSWORD');
        }
        database = env.get(`${p}_DATABASE`) ?? env.get('MYSQL_DATABASE');
        break;
      }
      case 'mongodb':
        user = env.get('MONGO_INITDB_ROOT_USERNAME');
        password = env.get('MONGO_INITDB_ROOT_PASSWORD');
        database = env.get('MONGO_INITDB_DATABASE');
        break;
      case 'sqlserver':
        user = 'sa';
        password = env.get('MSSQL_SA_PASSWORD') ?? env.get('SA_PASSWORD');
        break;
      case 'clickhouse':
        user = env.get('CLICKHOUSE_USER') ?? 'default';
        password = env.get('CLICKHOUSE_PASSWORD');
        database = env.get('CLICKHOUSE_DB');
        break;
      case 'oracle':
        user = env.get('APP_USER') ?? 'system';
        password = env.get('APP_USER') ? env.get('APP_USER_PASSWORD') : env.get('ORACLE_PASSWORD');
        database = env.get('ORACLE_DATABASE') ?? 'FREEPDB1';
        break;
      case 'redis': {
        const command = (def as { command?: unknown }).command;
        const text = Array.isArray(command) ? command.join(' ') : scalarText(command);
        password = /--requirepass\s+("[^"]+"|'[^']+'|\S+)/.exec(text)?.[1]?.replace(/^["']|["']$/g, '');
        password = password ? resolveComposeValue(password) : env.get('REDIS_PASSWORD');
        break;
      }
      default:
        break;
    }
    out.push({
      source: `${rel}: service ${service} (${image})`,
      name: service,
      connection: {
        engine,
        host: 'localhost',
        port: port ?? CONTAINER_PORTS[engine],
        ...(user && engine !== 'redis' ? { user } : {}),
        ...(database ? { database } : {}),
        options: engine === 'mongodb' && user ? { authSource: 'admin' } : {},
        ...(engine === 'sqlserver' ? { tls: { trustServerCertificate: true } } : {}),
      },
      ...(password ? { secret: password } : {}),
    });
  }
  return out;
}

/** File kinds the scan reads. */
export function fileKind(name: string): 'env' | 'appsettings' | 'properties' | 'yaml' | 'compose' | 'prisma' | null {
  const n = name.toLowerCase();
  if (n === '.env' || (n.startsWith('.env.') && !n.endsWith('.vault'))) return 'env';
  if (/^appsettings(\.[\w-]+)?\.json$/.test(n)) return 'appsettings';
  if (/^application(-[\w-]+)?\.properties$/.test(n)) return 'properties';
  if (/^application(-[\w-]+)?\.ya?ml$/.test(n)) return 'yaml';
  if (/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/.test(n)) return 'compose';
  if (n === 'schema.prisma') return 'prisma';
  return null;
}

/** Connections found in one file (errors in the file yield nothing). */
export function detectInFile(rel: string, content: string, hints: Map<string, DatabaseEngine> = new Map()): Detected[] {
  const name = rel.split(/[\\/]/).pop() ?? rel;
  try {
    switch (fileKind(name)) {
      case 'env':
        return fromEnv(rel, content, hints);
      case 'appsettings':
        return fromAppSettings(rel, content);
      case 'properties': {
        const props = parseProperties(content);
        return fromSpring(rel, (k) => props.get(k));
      }
      case 'yaml': {
        const docs = content.split(/^---\s*$/m).map((d) => parseYaml(d) as unknown);
        return docs.flatMap((doc) => fromSpring(rel, (k) => yamlGet(doc, k)));
      }
      case 'compose':
        return fromCompose(rel, content);
      default:
        return [];
    }
  } catch {
    return [];
  }
}
