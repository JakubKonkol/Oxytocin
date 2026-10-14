import { describe, expect, it } from 'vitest';
import { DatabaseServerSchema } from '@shared/domain/database-servers';
import { describeServer, newlyFound, serverSecretChanges, typedPassword } from './servers-model';

const server = DatabaseServerSchema.parse({
  id: 's1',
  name: 'FIRMA_1',
  engine: 'sqlserver',
  host: '10.10.10.15',
  databases: [{ name: 'WMS_DB' }],
});

describe('database servers model', () => {
  it('describes a server', () => {
    expect(describeServer(server)).toBe('SQL Server · 10.10.10.15 · 1 database');
    expect(describeServer({ ...server, host: '', port: 1444, databases: [] })).toBe(
      'SQL Server · no host · 0 databases',
    );
  });

  it('offers only discovered databases that are not on the list, system ones on request', () => {
    const result = {
      ok: true,
      databases: [
        { name: 'master', system: true },
        { name: 'wms_db', system: false },
        { name: 'SALES', system: false },
      ],
    };
    expect(newlyFound(result, server, false).map((d) => d.name)).toEqual(['SALES']);
    expect(newlyFound(result, server, true).map((d) => d.name)).toEqual(['master', 'SALES']);
    expect(newlyFound({ ok: false, databases: [] }, server, true)).toEqual([]);
    expect(newlyFound(undefined, server, true)).toEqual([]);
  });

  it('sends password changes of existing servers only, and the typed password to discovery', () => {
    const edits = { 's1/password': { value: 'pw' }, 'gone/password': { value: 'x' } };
    expect(serverSecretChanges([server], edits)).toEqual([{ resourceId: 's1', key: 'password', value: 'pw' }]);
    expect(serverSecretChanges([server], { 's1/password': { remove: true } })).toEqual([
      { resourceId: 's1', key: 'password', value: null },
    ]);
    expect(typedPassword(edits, 's1')).toBe('pw');
    expect(typedPassword({ 's1/password': { remove: true } }, 's1')).toBeNull();
    expect(typedPassword({}, 's1')).toBeUndefined();
  });
});
