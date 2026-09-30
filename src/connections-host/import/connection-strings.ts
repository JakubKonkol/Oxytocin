import type { DatabaseEngine, TlsMode } from '@shared/domain/project-resources';

/** A connection split into fields; `password` is the secret. */
export interface ParsedConnection {
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  options: Record<string, string>;
  tls?: { mode?: TlsMode; trustServerCertificate?: boolean };
  /** A file database (SQLite). */
  path?: string;
  /** The value is best kept as a whole URL (MongoDB SRV, options the fields cannot express). */
  keepAsUrl?: boolean;
}

const SCHEMES: Record<string, DatabaseEngine> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  cockroachdb: 'cockroachdb',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  redis: 'redis',
  rediss: 'redis',
  sqlserver: 'sqlserver',
  mssql: 'sqlserver',
  clickhouse: 'clickhouse',
  oracle: 'oracle',
  sqlite: 'sqlite',
};

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const truthy = (v: string | undefined) => v !== undefined && /^(true|yes|1|on)$/i.test(v.trim());

function sslMode(value: string | undefined): TlsMode | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (['disable', 'disabled', 'false', 'off', 'no', '0'].includes(v)) return 'disable';
  if (['verify-full', 'verify-ca', 'verify_identity', 'verify_ca', 'verify'].includes(v)) return 'verify';
  if (['require', 'required', 'true', 'on', 'yes', '1', 'mandatory', 'strict'].includes(v)) return 'require';
  if (['prefer', 'preferred', 'allow', 'optional'].includes(v)) return 'prefer';
  return undefined;
}

/** `postgres://user:pass@host:5432/db?sslmode=require`, `mongodb+srv://…`, `redis://…`, `sqlite:./x.db`. */
export function parseUrl(value: string, engineHint?: DatabaseEngine): ParsedConnection | null {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (!scheme) return null;
  let engine = SCHEMES[scheme];
  if (scheme === 'file' || scheme === 'sqlite') {
    const path = trimmed.replace(/^(sqlite|file):(\/\/)?/i, '');
    return path ? { engine: 'sqlite', path: decode(path), options: {} } : null;
  }
  if ((scheme === 'http' || scheme === 'https') && engineHint === 'clickhouse') engine = 'clickhouse';
  if (!engine) return null;
  if (
    engineHint &&
    SCHEMES[scheme] &&
    ['mysql', 'mariadb'].includes(engine) &&
    ['mysql', 'mariadb'].includes(engineHint)
  )
    engine = engineHint;
  if (engineHint === 'cockroachdb' && engine === 'postgresql') engine = 'cockroachdb';
  let url: URL;
  try {
    url = new URL(trimmed.replace(/^mongodb\+srv:/i, 'http:').replace(/^[a-z][a-z0-9+.-]*:/i, 'http:'));
  } catch {
    return null;
  }
  const options: Record<string, string> = {};
  for (const [k, v] of url.searchParams) options[k] = v;
  const database = decode(url.pathname.replace(/^\//, '')) || undefined;
  const parsed: ParsedConnection = {
    engine,
    host: decode(url.hostname.replace(/^\[|\]$/g, '')) || undefined,
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(database ? { database } : {}),
    ...(url.username ? { user: decode(url.username) } : {}),
    ...(url.password ? { password: decode(url.password) } : {}),
    options,
  };
  const mode = sslMode(
    options['sslmode'] ?? options['ssl-mode'] ?? options['ssl'] ?? options['tls'] ?? options['encrypt'],
  );
  if (scheme === 'rediss') parsed.tls = { mode: 'require' };
  else if (mode) parsed.tls = { mode };
  if (truthy(options['trustServerCertificate'])) parsed.tls = { ...parsed.tls, trustServerCertificate: true };
  if (engine === 'mongodb') parsed.keepAsUrl = true;
  if (engine === 'redis' && database && /^\d+$/.test(database)) {
    delete parsed.database;
    parsed.options['db'] = database;
  }
  if (engine === 'redis' && !parsed.user && parsed.password === undefined && url.username)
    parsed.password = decode(url.username);
  return parsed;
}

/** `key=value;key=value` (ADO.NET, Npgsql, MySqlConnector, ODBC-like), keys case-insensitive. */
export function parseKeyValue(value: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const s = value.trim();
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (s[j] === ' ') j++;
    let v = '';
    if (s[j] === '"' || s[j] === "'") {
      const q = s[j]!;
      j++;
      while (j < s.length) {
        if (s[j] === q && s[j + 1] === q) {
          v += q;
          j += 2;
        } else if (s[j] === q) {
          j++;
          break;
        } else v += s[j++];
      }
      const semi = s.indexOf(';', j);
      i = semi < 0 ? s.length : semi + 1;
    } else {
      const semi = s.indexOf(';', j);
      v = s.slice(j, semi < 0 ? s.length : semi).trim();
      i = semi < 0 ? s.length : semi + 1;
    }
    if (key) out.set(key, v);
  }
  return out;
}

const first = (m: Map<string, string>, ...keys: string[]) => {
  for (const k of keys) {
    const v = m.get(k);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};

/**
 * ADO.NET / Npgsql / MySqlConnector connection strings. `Host=` and `Username=` mean Npgsql (PostgreSQL); `Uid=`
 * with a MySQL hint means MySQL; everything else with `Server=`/`Data Source=` is SQL Server.
 */
export function parseAdoNet(value: string, engineHint?: DatabaseEngine): ParsedConnection | null {
  const m = parseKeyValue(value);
  if (m.size === 0) return null;
  const hasAny = (...keys: string[]) => keys.some((k) => m.has(k));
  if (!hasAny('server', 'data source', 'host', 'address', 'addr', 'network address', 'datasource')) {
    const file = first(m, 'data source', 'datasource', 'filename');
    if (!file) return null;
  }
  let engine: DatabaseEngine;
  if (engineHint && engineHint !== 'mongodb' && engineHint !== 'redis') engine = engineHint;
  else if (hasAny('host', 'username') && !hasAny('data source')) engine = 'postgresql';
  else if (
    hasAny('uid', 'pwd', 'sslmode', 'allowuservariables') &&
    !hasAny('initial catalog', 'trustservercertificate')
  )
    engine = 'mysql';
  else engine = 'sqlserver';
  const rawServer = first(m, 'server', 'data source', 'datasource', 'host', 'address', 'addr', 'network address');
  if (m.size === 1 && !(rawServer && /\.(db|sqlite3?|s3db)$/i.test(rawServer))) return null;
  if (engine === 'sqlite' || (rawServer && /\.(db|sqlite3?|s3db)$/i.test(rawServer) && !hasAny('initial catalog'))) {
    return rawServer ? { engine: 'sqlite', path: rawServer, options: {} } : null;
  }
  const options: Record<string, string> = {};
  let host = rawServer?.replace(/^tcp:/i, '');
  let port = first(m, 'port') ? Number(first(m, 'port')) : undefined;
  if (host && engine === 'sqlserver') {
    const comma = /^(.*),\s*(\d+)$/.exec(host);
    if (comma) {
      host = comma[1];
      port = Number(comma[2]);
    }
    const slash = /^([^\\]+)\\(.+)$/.exec(host ?? '');
    if (slash) {
      host = slash[1];
      options['instanceName'] = slash[2]!;
    }
    if (host === '.' || host?.toLowerCase() === '(local)') host = 'localhost';
  }
  const parsed: ParsedConnection = {
    engine,
    ...(host ? { host } : {}),
    ...(port && Number.isFinite(port) ? { port } : {}),
    options,
  };
  const database = first(m, 'database', 'initial catalog', 'db');
  if (database) parsed.database = database;
  const user = first(m, 'user id', 'userid', 'user', 'username', 'uid', 'user name');
  if (user) parsed.user = user;
  const password = first(m, 'password', 'pwd');
  if (password !== undefined) parsed.password = password;
  if (engine === 'sqlserver') {
    if (truthy(m.get('trustservercertificate'))) parsed.tls = { trustServerCertificate: true };
    const encrypt = m.get('encrypt');
    if (encrypt !== undefined) {
      const mode = /^(false|no|optional)$/i.test(encrypt) ? 'disable' : 'require';
      parsed.tls = { ...parsed.tls, mode };
    }
    if (truthy(m.get('integrated security')) || m.get('trusted_connection')?.toLowerCase() === 'true')
      options['integratedSecurity'] = 'true';
  } else {
    const mode = sslMode(first(m, 'ssl mode', 'sslmode', 'ssl'));
    if (mode) parsed.tls = { mode };
    if (truthy(m.get('trust server certificate'))) parsed.tls = { ...parsed.tls, trustServerCertificate: true };
  }
  return parsed;
}

/**
 * JDBC URLs: `jdbc:postgresql://h:5432/db?user=…`, `jdbc:sqlserver://h:1433;databaseName=…;encrypt=true`,
 * `jdbc:mysql://…`, `jdbc:mariadb://…`, `jdbc:oracle:thin:@//h:1521/service` and `@h:1521:SID`, `jdbc:sqlite:x.db`.
 */
export function parseJdbc(value: string): ParsedConnection | null {
  const v = value.trim();
  if (!/^jdbc:/i.test(v)) return null;
  const rest = v.slice(5);
  if (/^sqlserver:/i.test(rest)) {
    const [head, ...props] = rest.slice('sqlserver:'.length).split(';');
    const m = parseKeyValue(props.join(';'));
    const hostPart = (head ?? '').replace(/^\/\//, '');
    const hostMatch = /^([^:\\/]*)(?:\\([^:/]+))?(?::(\d+))?/.exec(hostPart);
    const options: Record<string, string> = {};
    if (hostMatch?.[2]) options['instanceName'] = hostMatch[2];
    const inst = first(m, 'instancename');
    if (inst) options['instanceName'] = inst;
    const parsed: ParsedConnection = {
      engine: 'sqlserver',
      ...(hostMatch?.[1] ? { host: hostMatch[1] } : {}),
      ...(hostMatch?.[3] ? { port: Number(hostMatch[3]) } : {}),
      options,
    };
    const database = first(m, 'databasename', 'database');
    if (database) parsed.database = database;
    const user = first(m, 'user', 'username', 'userid');
    if (user) parsed.user = user;
    const password = first(m, 'password');
    if (password !== undefined) parsed.password = password;
    if (truthy(m.get('trustservercertificate'))) parsed.tls = { trustServerCertificate: true };
    const encrypt = m.get('encrypt');
    if (encrypt !== undefined) parsed.tls = { ...parsed.tls, mode: /^false$/i.test(encrypt) ? 'disable' : 'require' };
    return parsed;
  }
  if (/^oracle:thin:@/i.test(rest)) {
    const target = rest.replace(/^oracle:thin:@/i, '');
    const easy = /^\/\/([^:/]+)(?::(\d+))?\/(.+)$/.exec(target);
    if (easy)
      return {
        engine: 'oracle',
        host: easy[1]!,
        ...(easy[2] ? { port: Number(easy[2]) } : {}),
        database: easy[3]!,
        options: {},
      };
    const sid = /^([^:/]+):(\d+):(.+)$/.exec(target);
    if (sid)
      return { engine: 'oracle', host: sid[1]!, port: Number(sid[2]), database: sid[3]!, options: { sid: 'true' } };
    return null;
  }
  if (/^sqlite:/i.test(rest)) return { engine: 'sqlite', path: rest.slice(7), options: {} };
  const parsed = parseUrl(rest.replace(/^(\w+):/, (_m, s: string) => `${s}:`));
  if (!parsed) return null;
  for (const key of ['user', 'username']) {
    if (parsed.options[key] && !parsed.user) parsed.user = parsed.options[key];
    delete parsed.options[key];
  }
  if (parsed.options['password'] !== undefined && parsed.password === undefined)
    parsed.password = parsed.options['password'];
  delete parsed.options['password'];
  return parsed;
}

/** Any supported form: URL, JDBC URL or key=value connection string. */
export function parseConnectionString(value: string, engineHint?: DatabaseEngine): ParsedConnection | null {
  const v = value.trim();
  if (!v) return null;
  if (/^jdbc:/i.test(v)) return parseJdbc(v);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^(sqlite|file):/i.test(v)) return parseUrl(v, engineHint);
  if (v.includes('=') && v.includes(';')) return parseAdoNet(v, engineHint);
  return null;
}

/** The engine a variable, file or service name suggests (`PG_URL`, `mysql`, `ConnectionStrings.Mongo`). */
export function engineFromHint(text: string): DatabaseEngine | undefined {
  const t = text.toLowerCase();
  if (/cockroach/.test(t)) return 'cockroachdb';
  if (/postgres|pgsql|npgsql|(^|_)pg_?/.test(t)) return 'postgresql';
  if (/maria/.test(t)) return 'mariadb';
  if (/mysql/.test(t)) return 'mysql';
  if (/mongo/.test(t)) return 'mongodb';
  if (/redis|valkey/.test(t)) return 'redis';
  if (/mssql|sqlserver|sql_server/.test(t)) return 'sqlserver';
  if (/clickhouse/.test(t)) return 'clickhouse';
  if (/oracle/.test(t)) return 'oracle';
  if (/sqlite/.test(t)) return 'sqlite';
  return undefined;
}
