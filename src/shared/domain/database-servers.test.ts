import { describe, expect, it } from 'vitest';
import {
  addDatabases,
  DatabaseServerSchema,
  isSystemDatabase,
  linkedDatabase,
  materializeLinked,
  newServer,
  serverAsResource,
  validateServers,
} from './database-servers';
import { buildAgentBrief, emptyResources, sharedConfigOf, validateResources } from './project-resources';

const server = (extra: Record<string, unknown> = {}) =>
  DatabaseServerSchema.parse({
    id: 's1',
    name: 'FIRMA_1',
    engine: 'sqlserver',
    host: '10.10.10.15',
    user: 'reader',
    options: { instanceName: 'PROD' },
    tls: { mode: 'prefer', trustServerCertificate: true },
    databases: [{ name: 'WMS_DB', description: 'Stock in pieces.' }, { name: 'HR' }],
    ...extra,
  });

describe('database servers', () => {
  it('validates names, hosts and duplicate databases', () => {
    expect(validateServers([server()])).toEqual([]);
    expect(validateServers([server(), server({ id: 's2' })])).toEqual(['Two servers are named "FIRMA_1".']);
    expect(validateServers([server({ name: 'A/B' })])[0]).toMatch(/cannot contain/);
    expect(validateServers([server({ host: ' ' })])[0]).toMatch(/host is missing/);
    expect(validateServers([server({ engine: 'oracle' })])[0]).toMatch(/service name/);
    expect(validateServers([server({ databases: [{ name: 'x' }, { name: 'X' }] })])[0]).toMatch(/listed twice/);
  });

  it('links a database into a project as a read-only resource named server/database', () => {
    const db = linkedDatabase(emptyResources(), server(), 'WMS_DB');
    expect(db).toMatchObject({
      name: 'FIRMA_1/WMS_DB',
      engine: 'sqlserver',
      environment: 'dev',
      connection: { kind: 'server', serverId: 's1', database: 'WMS_DB' },
      access: { mode: 'read-only' },
      agents: { exposed: true, description: 'Stock in pieces.' },
    });
    // The same database of two servers can be linked side by side.
    const other = linkedDatabase(
      { ...emptyResources(), databases: [db] },
      server({ id: 's2', name: 'FIRMA_02' }),
      'WMS_DB',
    );
    expect(other.id).not.toBe(db.id);
    expect(validateResources({ ...emptyResources(), databases: [db, other] })).toEqual([]);
  });

  it('connects a linked database through its server', () => {
    const db = linkedDatabase(emptyResources(), server(), 'WMS_DB');
    expect(materializeLinked(db, server({ port: 1444 }))).toMatchObject({
      engine: 'sqlserver',
      connection: {
        kind: 'fields',
        host: '10.10.10.15',
        port: 1444,
        user: 'reader',
        database: 'WMS_DB',
        options: { instanceName: 'PROD' },
      },
      tls: { trustServerCertificate: true },
    });
    // Redis: the database is a number option.
    const redis = server({ engine: 'redis', options: {}, tls: undefined });
    expect(materializeLinked(linkedDatabase(emptyResources(), redis, '3'), redis).connection).toEqual({
      kind: 'fields',
      host: '10.10.10.15',
      user: 'reader',
      options: { db: '3' },
    });
  });

  it('discovers through the engine’s default database', () => {
    expect(serverAsResource(server()).connection).toMatchObject({ database: 'master' });
    expect(serverAsResource(server({ engine: 'postgresql' })).connection).toMatchObject({ database: 'postgres' });
    expect(serverAsResource(server({ engine: 'mysql' })).connection).not.toHaveProperty('database');
    expect(serverAsResource(server({ database: 'tools' })).connection).toMatchObject({ database: 'tools' });
  });

  it('knows system databases and merges discovered names', () => {
    expect(isSystemDatabase('sqlserver', 'tempdb')).toBe(true);
    expect(isSystemDatabase('sqlserver', 'WMS_DB')).toBe(false);
    expect(isSystemDatabase('mongodb', 'admin')).toBe(true);
    expect(addDatabases(server(), ['wms_db', 'SALES', ' ']).databases.map((d) => d.name)).toEqual([
      'WMS_DB',
      'HR',
      'SALES',
    ]);
  });

  it('new servers get unique names and engine defaults', () => {
    const a = newServer([], 'sqlserver');
    expect(a).toMatchObject({ name: 'SERVER_1', user: 'sa', tls: { trustServerCertificate: true } });
    expect(newServer([a], 'postgresql')).toMatchObject({ name: 'SERVER_2', user: 'postgres' });
  });

  it('linked databases stay out of the repository file and are grouped by server in the brief', () => {
    const db = linkedDatabase(emptyResources(), server(), 'WMS_DB');
    expect(sharedConfigOf({ ...emptyResources(), databases: [db] }).resources.databases).toEqual([]);
    const brief = buildAgentBrief('PROJECT_01', [
      { kind: 'database', name: 'FIRMA_1/WMS_DB', server: 'FIRMA_1', engine: 'sqlserver', mode: 'read-only' },
      { kind: 'database', name: 'FIRMA_02/WMS_DB', server: 'FIRMA_02', engine: 'sqlserver', mode: 'read-only' },
      { kind: 'database', name: 'local', engine: 'sqlite' },
    ]);
    expect(brief).toContain('- database "local" (SQLite');
    expect(brief).toContain('- database server "FIRMA_1" (SQL Server):\n  - database "FIRMA_1/WMS_DB" (SQL Server');
    expect(brief).toContain('- database server "FIRMA_02" (SQL Server):\n  - database "FIRMA_02/WMS_DB"');
  });
});
