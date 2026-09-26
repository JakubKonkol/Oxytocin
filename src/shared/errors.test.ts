import { describe, expect, it } from 'vitest';
import { decodeIpcError, encodeIpcError, OxyError, toSerializedError } from './errors';

describe('errors', () => {
  it('serializes OxyError with details', () => {
    expect(toSerializedError(new OxyError('NOT_FOUND', 'nope', { id: 1 }))).toEqual({
      code: 'NOT_FOUND',
      message: 'nope',
      details: { id: 1 },
    });
  });

  it('maps unknown errors to INTERNAL', () => {
    expect(toSerializedError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(toSerializedError('x')).toEqual({ code: 'INTERNAL', message: 'x' });
  });

  it('round-trips through an IPC error message, even when Electron prefixes it', () => {
    const encoded = encodeIpcError({ code: 'INVALID', message: 'bad' });
    expect(decodeIpcError(`Error invoking remote method 'x': Error: ${encoded}`)).toEqual({
      code: 'INVALID',
      message: 'bad',
    });
    expect(decodeIpcError('plain')).toBeNull();
  });
});
