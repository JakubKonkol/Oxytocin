import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '@shared/logging/logger';
import { SecretStore, type SafeStorageLike } from '../secrets/secret-store';
import { ResourceService } from './resource-service';

const logger: Logger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };
const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`x${s}`),
  decryptString: (b) => b.toString().slice(1),
};

const PROJECTS = [
  { id: 'api', name: 'bank-api', rootPath: '/p/api' },
  { id: 'web', name: 'bank-client', rootPath: '/p/web' },
  { id: 'other', name: 'other', rootPath: '/p/other' },
];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-res-'));
  const secrets = new SecretStore(join(dir, 'secrets.json'), safe, logger);
  const service = new ResourceService({ file: join(dir, 'res.json'), secrets, projects: () => PROJECTS, logger });
  await service.load();
  return { dir, secrets, service };
}

const db = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  engine: 'postgresql',
  connection: { kind: 'fields', host: 'localhost', port: 5432, user: 'app', options: {} },
  ...extra,
});

describe('ResourceService', () => {
  it('saves resources with secrets, validates and reports changes', async () => {
    const { service, secrets } = await setup();
    const changes: string[][] = [];
    service.onDidChange((c) => changes.push(c.changedKeys));
    await service.save('api', { databases: [db('d1', 'bank-db')] }, [
      { resourceId: 'd1', key: 'password', value: 'pw' },
    ]);
    expect(service.get('api').databases[0]).toMatchObject({ name: 'bank-db', access: { mode: 'read-only' } });
    expect(secrets.getAll('api', 'd1')).toEqual({ password: 'pw' });
    await expect(
      service.save('api', {
        databases: [db('d1', 'bank-db', { environment: 'production', access: { mode: 'read-write' } })],
      }),
    ).rejects.toThrow(/production/);
    await expect(service.save('api', {}, [{ resourceId: 'nope', key: 'password', value: 'x' }])).rejects.toThrow(
      /No database/,
    );
    // Removing the database deletes its secret.
    await service.save('api', { databases: [] });
    expect(secrets.getAll('api', 'd1')).toEqual({});
    expect(changes.at(-1)).toEqual(['api/d1']);
  });

  it('keeps unknown fields and an unreadable entry from a newer version', async () => {
    const { dir, service } = await setup();
    await service.save('api', { databases: [db('d1', 'bank-db', { futureField: 42 })], futureTop: 'x' });
    const file = JSON.parse(await readFile(join(dir, 'res.json'), 'utf8')) as { projects: Record<string, unknown> };
    expect(JSON.stringify(file.projects['api'])).toContain('futureField');
    expect(JSON.stringify(file.projects['api'])).toContain('futureTop');
    await writeFile(
      join(dir, 'res.json'),
      JSON.stringify({ version: 1, projects: { web: { databases: [db('d', 'x', { engine: 'cassandra' })] } } }),
    );
    const reloaded = new ResourceService({
      file: join(dir, 'res.json'),
      secrets: new SecretStore(join(dir, 's.json'), safe, logger),
      projects: () => PROJECTS,
      logger,
    });
    await reloaded.load();
    expect(reloaded.unreadable('web')).toBe(true);
    expect(reloaded.get('web').databases).toEqual([]);
    // Saving another project leaves it as it was.
    await reloaded.save('api', { relatedProjectIds: ['web'] });
    expect(JSON.stringify(JSON.parse(await readFile(join(dir, 'res.json'), 'utf8')))).toContain('cassandra');
  });

  it('shares resources with related projects on both sides', async () => {
    const { service } = await setup();
    await service.save('api', {
      databases: [db('d1', 'bank-db'), db('d2', 'shared-db', { agents: { exposed: true, shareWithRelated: true } })],
      apis: [
        {
          id: 'a1',
          name: 'bank-api',
          baseUrl: 'http://localhost:5000',
          agents: { exposed: true, shareWithRelated: true },
        },
      ],
      relatedProjectIds: ['web'],
    });
    expect(service.get('web').relatedProjectIds).toEqual(['api']);
    const web = service.accessible('web');
    expect(web.map((a) => `${a.kind}:${a.resource.name}:${a.own}`)).toEqual([
      'database:shared-db:false',
      'api:bank-api:false',
    ]);
    expect(service.find('web', 'database', 'bank-api/shared-db').resource.id).toBe('d2');
    expect(service.find('web', 'database', 'shared-db').resource.id).toBe('d2');
    expect(() => service.find('web', 'database', 'bank-db')).toThrow(/No database "bank-db"/);
    expect(service.find('api', 'api', undefined).resource.id).toBe('a1');
    expect(() => service.find('api', 'database', undefined)).toThrow(/Pass the database name/);
    // Unlinking from the other side removes both directions.
    await service.save('web', { relatedProjectIds: [] });
    expect(service.get('api').relatedProjectIds).toEqual([]);
    expect(service.accessible('web')).toEqual([]);
  });

  it('knows which kinds exist, hides production URLs from the brief and removes projects', async () => {
    const { service, secrets } = await setup();
    expect([...service.kinds()]).toEqual([]);
    await service.save(
      'api',
      {
        databases: [
          db('d1', 'bank-db', { agents: { exposed: true, description: 'Balances are in cents.' } }),
          db('m1', 'docs', { engine: 'mongodb', connection: { kind: 'url' } }),
        ],
        apis: [{ id: 'a1', name: 'prod-api', baseUrl: 'https://api.bank.example', environment: 'production' }],
        logs: [{ id: 'l1', name: 'app-log', path: 'logs/*.log' }],
      },
      [{ resourceId: 'm1', key: 'url', value: 'mongodb://x' }],
    );
    expect([...service.kinds()].sort()).toEqual(['any', 'api', 'log', 'mongodb', 'sql']);
    const brief = service.brief('api', (a) => (typeof a.baseUrl === 'string' ? a.baseUrl : undefined));
    expect(brief).toContain(
      'database "bank-db" (PostgreSQL, local, read-only) — use oxy_db_schema / oxy_db_query — Balances are in cents.',
    );
    expect(brief).toContain('database "docs" (MongoDB');
    expect(brief).toContain('API "prod-api" (production, methods: GET, HEAD, OPTIONS)');
    expect(brief).not.toContain('api.bank.example');
    const resolved = service.resolveDatabase(PROJECTS[0]!, service.get('api').databases[1]!);
    expect(resolved).toMatchObject({ key: 'api/m1', secrets: { url: 'mongodb://x' }, projectRoot: '/p/api' });
    await service.removeProject('api');
    expect(service.get('api').databases).toEqual([]);
    expect(secrets.status('api').stored).toEqual([]);
  });
});
