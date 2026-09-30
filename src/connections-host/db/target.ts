import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ENGINE_INFO, type DatabaseEngine, type DatabaseTls } from '@shared/domain/project-resources';
import type { ResolvedDatabase } from '@shared/rpc/contracts/connections-host';
import { parseConnectionString, type ParsedConnection } from '../import/connection-strings';
import { parseEnvFile } from '../import/env-file';

/** Where and how a driver connects, with the secret. */
export interface Target {
  engine: DatabaseEngine;
  host: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  options: Record<string, string>;
  tls: DatabaseTls;
  /** SQLite. */
  path?: string;
  /** A URL to hand to the driver as is (MongoDB). */
  url?: string;
  /** Every secret value of this target (scrubbed from errors). */
  secrets: string[];
}

export class ConfigError extends Error {}

/** A path from the configuration: absolute, or relative to the project root (Windows or POSIX separators). */
export const projectPath = (root: string, path: string): string =>
  isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') ? path : resolve(root, path);

async function readEnvVariable(root: string, file: string, variable: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(projectPath(root, file), 'utf8');
  } catch {
    throw new ConfigError(`The env file ${file} could not be read.`);
  }
  const value = parseEnvFile(text).get(variable);
  if (!value) throw new ConfigError(`${variable} is not set in ${file}.`);
  return value;
}

function fromParsed(engine: DatabaseEngine, parsed: ParsedConnection, raw: string, tls: DatabaseTls): Target {
  return {
    engine,
    host: parsed.host ?? 'localhost',
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(parsed.database ? { database: parsed.database } : {}),
    ...(parsed.user ? { user: parsed.user } : {}),
    ...(parsed.password !== undefined ? { password: parsed.password } : {}),
    options: parsed.options,
    tls: {
      ...tls,
      ...(parsed.tls?.mode ? { mode: parsed.tls.mode } : {}),
      ...(parsed.tls?.trustServerCertificate ? { trustServerCertificate: true } : {}),
    },
    ...(parsed.path ? { path: parsed.path } : {}),
    ...(engine === 'mongodb' || engine === 'redis' ? { url: raw } : {}),
    secrets: [raw, ...(parsed.password ? [parsed.password] : [])],
  };
}

/** Resolves a resource's connection: fields + password, a URL secret, an env file variable or a SQLite file. */
export async function resolveTarget(db: ResolvedDatabase): Promise<Target> {
  const { resource, secrets, projectRoot } = db;
  const engine = resource.engine;
  const tls: DatabaseTls = resource.tls ?? { mode: 'prefer', trustServerCertificate: false };
  const c = resource.connection;
  switch (c.kind) {
    case 'fields': {
      const password = secrets['password'];
      return {
        engine,
        host: c.host.trim() || 'localhost',
        port: c.port ?? ENGINE_INFO[engine].defaultPort,
        ...(c.database ? { database: c.database } : {}),
        ...(c.user ? { user: c.user } : {}),
        ...(password !== undefined ? { password } : {}),
        options: c.options,
        tls,
        secrets: password ? [password] : [],
      };
    }
    case 'file':
      return { engine, host: '', path: projectPath(projectRoot, c.path), options: {}, tls, secrets: [] };
    case 'url':
    case 'env-ref': {
      const raw = c.kind === 'url' ? secrets['url'] : await readEnvVariable(projectRoot, c.file, c.variable);
      if (!raw) throw new ConfigError('The connection URL is not set: enter it in Project settings → Databases.');
      const parsed = parseConnectionString(raw, engine);
      if (!parsed) throw new ConfigError('The connection URL or connection string could not be read.');
      if (engine === 'sqlite') {
        if (!parsed.path) throw new ConfigError('The value is not a SQLite file path.');
        return { engine, host: '', path: projectPath(projectRoot, parsed.path), options: {}, tls, secrets: [] };
      }
      return fromParsed(engine, parsed, raw, tls);
    }
  }
}
