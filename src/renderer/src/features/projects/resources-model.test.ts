import { describe, expect, it } from 'vitest';
import { emptyResources, type ImportCandidate } from '@shared/domain/project-resources';
import {
  databaseFromCandidate,
  draftSecretsOf,
  isLocalDb,
  newApi,
  newDatabase,
  resourceProblems,
  secretChanges,
  secretState,
} from './resources-model';

describe('resources model', () => {
  it('creates databases with engine defaults and unique names', () => {
    const r = emptyResources();
    const pg = newDatabase(r, 'postgresql');
    expect(pg).toMatchObject({
      name: 'postgresql',
      engine: 'postgresql',
      environment: 'local',
      connection: { kind: 'fields', host: 'localhost', port: 5432, user: 'postgres' },
      access: { mode: 'read-only', maxRows: 200 },
    });
    r.databases.push(pg);
    expect(newDatabase(r, 'postgresql').name).toBe('postgresql-2');
    expect(newDatabase(r, 'sqlite').connection).toEqual({ kind: 'file', path: 'app.db' });
    expect(newDatabase(r, 'sqlserver').tls).toMatchObject({ trustServerCertificate: true });
    expect(newApi(r)).toMatchObject({
      baseUrl: 'http://localhost:3000',
      access: { methods: ['GET', 'HEAD', 'OPTIONS'] },
    });
  });

  it('turns import candidates into references or copies', () => {
    const c: ImportCandidate = {
      source: '.env: DATABASE_URL',
      file: '.env',
      engine: 'postgresql',
      name: 'DATABASE_URL',
      host: 'db',
      port: 5433,
      database: 'bank',
      user: 'app',
      hasSecret: true,
      reference: { file: '.env', variable: 'DATABASE_URL' },
      token: 'tok',
    };
    const ref = databaseFromCandidate(emptyResources(), c, 'reference');
    expect(ref.resource.connection).toEqual({ kind: 'env-ref', file: '.env', variable: 'DATABASE_URL' });
    expect(ref.secrets).toEqual({});
    const copy = databaseFromCandidate(emptyResources(), c, 'copy');
    expect(copy.resource).toMatchObject({
      name: 'database_url',
      connection: { kind: 'fields', host: 'db', port: 5433 },
    });
    expect(copy.secrets).toEqual({ [`${copy.resource.id}/password`]: { importToken: 'tok' } });
    const mongo = databaseFromCandidate(emptyResources(), { ...c, engine: 'mongodb' }, 'copy');
    expect(mongo.resource.connection).toEqual({ kind: 'url' });
  });

  it('computes secret changes only for secrets in use', () => {
    const r = emptyResources();
    const db = newDatabase(r, 'postgresql');
    r.databases.push(db);
    const changes = secretChanges(r, {
      [`${db.id}/password`]: { value: 'pw' },
      [`${db.id}/url`]: { value: 'unused' },
      [`gone/password`]: { remove: true },
    });
    expect(changes).toEqual([
      { resourceId: db.id, key: 'password', value: 'pw' },
      { resourceId: 'gone', key: 'password', value: null },
    ]);
    expect(secretState([`${db.id}/password`], {}, db.id, 'password')).toBe('set');
    expect(secretState([], { [`${db.id}/password`]: { value: 'x' } }, db.id, 'password')).toBe('changed');
    expect(secretState([`${db.id}/password`], { [`${db.id}/password`]: { remove: true } }, db.id, 'password')).toBe(
      'unset',
    );
    expect(
      draftSecretsOf(db.id, { [`${db.id}/password`]: { value: 'x' }, [`${db.id}/url`]: { importToken: 't' } }),
    ).toEqual({
      secrets: { password: 'x' },
      importTokens: { url: 't' },
    });
  });

  it('reports problems', () => {
    const r = emptyResources();
    const db = newDatabase(r, 'postgresql');
    r.databases.push({ ...db, environment: 'production', access: { ...db.access, mode: 'read-write' } });
    r.databases.push({ ...newDatabase(r, 'sqlite'), connection: { kind: 'file', path: ' ' } });
    const problems = resourceProblems(r);
    expect(problems.some((p) => p.includes('production'))).toBe(true);
    expect(problems.some((p) => p.includes('database file'))).toBe(true);
    expect(isLocalDb('(localdb)\\MSSQLLocalDB')).toBe(true);
    expect(isLocalDb('localhost')).toBe(false);
  });
});
