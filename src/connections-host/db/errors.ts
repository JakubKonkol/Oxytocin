import type { ConnectionErrorKind, DatabaseEngine } from '@shared/domain/project-resources';
import { scrub } from '../format';
import { ConfigError } from './target';
import { scalarText } from '@shared/utils/text';

export interface DescribedError {
  kind: ConnectionErrorKind;
  /** Scrubbed message with the driver's code. */
  message: string;
  /** What to do next (for the agent). */
  hint?: string;
}

const text = (e: unknown): string => {
  if (e instanceof AggregateError && e.errors.length) return e.errors.map(text).join('; ');
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause && cause !== e && !e.message.includes(text(cause)) ? `${e.message} (${text(cause)})` : e.message;
  }
  return String(e);
};

const codeOf = (e: unknown): string | undefined => {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as { code?: unknown; errorNum?: unknown; number?: unknown; errno?: unknown };
  const code = o.code ?? o.errorNum ?? o.number;
  return scalarText(code) || undefined;
};

const UNKNOWN_OBJECT =
  /42P01|42703|ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR|\b1146\b|\b1054\b|Invalid object name|Invalid column name|no such table|no such column|ORA-00942|ORA-00904|UNKNOWN_TABLE|UNKNOWN_IDENTIFIER|does not exist|doesn't exist/i;

/** A driver error as the user and the agent see it: a kind, a scrubbed message and a hint. */
export function describeError(e: unknown, engine: DatabaseEngine, secrets: readonly string[]): DescribedError {
  const raw = text(e);
  const code = codeOf(e);
  const message = scrub(code && !raw.includes(code) ? `${code}: ${raw}` : raw, secrets).slice(0, 2000);
  const all = `${code ?? ''} ${raw}`;
  if (e instanceof ConfigError) return { kind: 'config', message };
  if (
    /timeout|timed out|ETIMEOUT|57014|canceling statement|max_execution_time|max_statement_time|TIMEOUT_EXCEEDED|NJS-123|DPI-1067|interrupted/i.test(
      all,
    )
  )
    return {
      kind: 'timeout',
      message,
      hint: 'The query took longer than the time limit of this database; narrow it (WHERE, LIMIT, indexed columns).',
    };
  if (
    /28P01|28000|ER_ACCESS_DENIED|ER_DBACCESS_DENIED|\b1045\b|ELOGIN|Login failed|AuthenticationFailed|Authentication failed|WRONGPASS|NOAUTH|ORA-01017|ORA-28000|AUTHENTICATION_FAILED|REQUIRED_PASSWORD|password authentication failed|\b516\b/i.test(
      all,
    )
  )
    return { kind: 'auth', message, hint: 'Check the user name and password of this database in Project settings.' };
  if (
    /self[- ]signed|certificate|CERT_|UNABLE_TO_VERIFY|SSL|TLS|ERR_TLS|DEPTH_ZERO|does not support SSL|The server does not support SSL/i.test(
      all,
    )
  )
    return {
      kind: 'tls',
      message,
      hint:
        engine === 'sqlserver'
          ? 'SQL Server encrypts connections by default: for a local server with a self-signed certificate turn on "Trust server certificate".'
          : 'Check the TLS setting of this database (a local server often needs "Disable" or "Prefer").',
    };
  if (
    /3D000|ER_BAD_DB_ERROR|\b1049\b|Cannot open database|UNKNOWN_DATABASE|ORA-12514|database .* does not exist|Unknown database/i.test(
      all,
    )
  )
    return { kind: 'database', message, hint: 'The database (or service name) does not exist on this server.' };
  if (
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|ESOCKET|getaddrinfo|connect ETIMEDOUT|Server selection timed out|Could not connect|Failed to connect|NJS-503|NJS-500|ORA-12541|ECONNCLOSED|Connection is closed/i.test(
      all,
    )
  )
    return {
      kind: 'unreachable',
      message,
      hint: 'The server is not reachable: is it running, and are the host and port right?',
    };
  if (UNKNOWN_OBJECT.test(all))
    return { kind: 'other', message, hint: 'Call oxy_db_schema to see the tables and columns of this database.' };
  return { kind: 'other', message };
}
