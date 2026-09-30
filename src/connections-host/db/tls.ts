import { readFile } from 'node:fs/promises';
import type { ConnectionOptions } from 'node:tls';
import type { Target } from './target';
import { ConfigError, projectPath } from './target';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host.toLowerCase());

/**
 * TLS options per mode: `disable` none; `prefer` encrypted when the server offers it, not verified (callers fall back
 * to a plain connection when the server has no TLS); `require` encrypted, not verified; `verify` encrypted and
 * verified (with the CA file when set).
 */
export async function tlsOptions(t: Target, root: string): Promise<ConnectionOptions | null> {
  const mode = t.tls.mode;
  if (mode === 'disable') return null;
  if (mode === 'verify') {
    let ca: string | undefined;
    if (t.tls.caPath) {
      try {
        ca = await readFile(projectPath(root, t.tls.caPath), 'utf8');
      } catch {
        throw new ConfigError(`The CA certificate ${t.tls.caPath} could not be read.`);
      }
    }
    return { rejectUnauthorized: true, ...(ca ? { ca } : {}), servername: t.host };
  }
  return { rejectUnauthorized: false };
}

/** Errors that mean "this server does not speak TLS": `prefer` then connects without it. */
export const isNoTlsError = (e: unknown): boolean =>
  /does not support SSL|server does not allow insecure|SSL (is )?not (enabled|supported)|HANDSHAKE_NO_SSL_SUPPORT|wrong version number|packet length too long|ssl3_get_record|EPROTO/i.test(
    e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e),
  );

/**
 * Tries connection variants in order and returns the first that works; the last error is thrown when none does.
 * Used for `prefer` TLS and for options some servers or poolers reject.
 */
export async function firstWorking<C, R>(
  variants: C[],
  attempt: (variant: C) => Promise<R>,
  retryable: (e: unknown) => boolean,
): Promise<R> {
  let last: unknown;
  for (let i = 0; i < variants.length; i++) {
    try {
      return await attempt(variants[i]!);
    } catch (e) {
      last = e;
      if (i === variants.length - 1 || !retryable(e)) throw e;
    }
  }
  throw last;
}
