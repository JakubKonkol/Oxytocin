export const OXY_ERROR_CODES = [
  'NOT_FOUND',
  'INVALID',
  'GIT_NOT_FOUND',
  'NOT_A_REPO',
  'SPAWN_FAILED',
  'PERMISSION',
  'TIMEOUT',
  'UNAVAILABLE',
  'CANCELLED',
  /** The file changed on disk since it was read (a save would overwrite someone else's change). */
  'CONFLICT',
  'INTERNAL',
] as const;

export type OxyErrorCode = (typeof OXY_ERROR_CODES)[number];

export interface SerializedOxyError {
  code: OxyErrorCode;
  message: string;
  details?: unknown;
}

export class OxyError extends Error {
  override readonly name = 'OxyError';

  constructor(
    readonly code: OxyErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON(): SerializedOxyError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isOxyErrorCode(value: unknown): value is OxyErrorCode {
  return typeof value === 'string' && (OXY_ERROR_CODES as readonly string[]).includes(value);
}

/** Converts anything thrown into a serializable error; unknown errors become INTERNAL. */
export function toSerializedError(e: unknown): SerializedOxyError {
  if (e instanceof OxyError) return e.toJSON();
  if (e && typeof e === 'object' && 'code' in e && isOxyErrorCode(e.code) && 'message' in e) {
    return { code: e.code, message: String(e.message) };
  }
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

export function fromSerializedError(e: SerializedOxyError): OxyError {
  return new OxyError(e.code, e.message, e.details);
}

const IPC_ERROR_PREFIX = 'OXY_ERROR:';

/** Electron only preserves `message` for errors thrown from ipcMain.handle, so we encode the payload in it. */
export function encodeIpcError(e: SerializedOxyError): string {
  return `${IPC_ERROR_PREFIX}${JSON.stringify(e)}`;
}

export function decodeIpcError(message: string): SerializedOxyError | null {
  const index = message.indexOf(IPC_ERROR_PREFIX);
  if (index < 0) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(index + IPC_ERROR_PREFIX.length));
    if (parsed && typeof parsed === 'object' && 'code' in parsed && isOxyErrorCode(parsed.code)) {
      return parsed as SerializedOxyError;
    }
  } catch {
    // fall through
  }
  return null;
}
