import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { detectInFile, fileKind, prismaHints } from './detect';
import { parseEnvFile } from './env-file';
import { ImportScanner } from './scan';

describe('parseEnvFile', () => {
  it('reads quoted, exported and commented values', () => {
    const env = parseEnvFile(
      'A=1\nexport B="two words"\nC=\'x#y\' # c\nD=plain # comment\n# E=no\nF="multi\\nline"\nG="a\nb"\n',
    );
    expect(Object.fromEntries(env)).toEqual({
      A: '1',
      B: 'two words',
      C: 'x#y',
      D: 'plain',
      F: 'multi\nline',
      G: 'a\nb',
    });
  });
});

describe('detectInFile', () => {
  it('finds URLs and grouped variables in .env files', () => {
    const found = detectInFile(
      '.env',
      'DATABASE_URL=postgres://app:pw@localhost:5432/bank\nREDIS_URL=redis://:rpw@localhost:6379\nMONGO_URI=mongodb://u:p@localhost/app\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=mpw\n',
    );
    expect(found.map((f) => [f.connection.engine, f.name, f.secret, f.reference?.variable])).toEqual([
      ['postgresql', 'DATABASE_URL', 'pw', 'DATABASE_URL'],
      ['redis', 'REDIS_URL', 'rpw', 'REDIS_URL'],
      ['mongodb', 'MONGO_URI', 'mongodb://u:p@localhost/app', 'MONGO_URI'],
      ['mysql', 'mysql (DB_HOST)', 'mpw', undefined],
    ]);
  });

  it('uses Prisma providers as hints', () => {
    const hints = prismaHints('datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n');
    expect(hints.get('DATABASE_URL')).toBe('mysql');
    expect(
      detectInFile('.env', 'DATABASE_URL=mysql://root:pw@db/shop', new Map([['DATABASE_URL', 'mariadb']]))[0]!
        .connection.engine,
    ).toBe('mariadb');
  });

  it('reads appsettings ConnectionStrings', () => {
    const found = detectInFile(
      'src/Api/appsettings.Development.json',
      '{ // comment\n "ConnectionStrings": { "Default": "Server=localhost,1433;Database=Bank;User Id=sa;Password=Pw_1;TrustServerCertificate=True", "Postgres": "Host=localhost;Database=x;Username=u;Password=p" } }',
    );
    expect(found.map((f) => [f.connection.engine, f.name, f.secret])).toEqual([
      ['sqlserver', 'Default', 'Pw_1'],
      ['postgresql', 'Postgres', 'p'],
    ]);
    expect(found[0]!.connection.tls).toEqual({ trustServerCertificate: true });
  });

  it('reads Spring properties and YAML', () => {
    const props = detectInFile(
      'src/main/resources/application.properties',
      'spring.datasource.url=jdbc:postgresql://localhost:5432/bank\nspring.datasource.username=app\nspring.datasource.password=${DB_PASSWORD:devpw}\nspring.data.mongodb.uri=mongodb://localhost/app\n',
    );
    expect(props.map((f) => [f.connection.engine, f.connection.user, f.secret])).toEqual([
      ['postgresql', 'app', 'devpw'],
      ['mongodb', undefined, 'mongodb://localhost/app'],
    ]);
    const yaml = detectInFile(
      'application-dev.yml',
      'spring:\n  datasource:\n    url: jdbc:mysql://localhost:3306/shop\n    username: root\n    password: secret\n  data:\n    redis:\n      host: localhost\n      port: 6380\n',
    );
    expect(yaml.map((f) => [f.connection.engine, f.connection.port, f.secret])).toEqual([
      ['mysql', 3306, 'secret'],
      ['redis', 6380, undefined],
    ]);
  });

  it('reads docker-compose services', () => {
    const found = detectInFile(
      'docker-compose.yml',
      `services:
  db:
    image: postgres:17
    ports: ["55432:5432"]
    environment:
      POSTGRES_PASSWORD: \${PG_PASSWORD:-devpw}
      POSTGRES_DB: bank
  sql:
    image: mcr.microsoft.com/mssql/server:2022-latest
    ports:
      - target: 1433
        published: 11433
    environment:
      - MSSQL_SA_PASSWORD=Strong_pw1
  cache:
    image: redis:7
    command: redis-server --requirepass cachepw
  web:
    image: node:24
`,
    );
    expect(
      found.map((f) => [f.connection.engine, f.connection.port, f.connection.user, f.connection.database, f.secret]),
    ).toEqual([
      ['postgresql', 55432, 'postgres', 'bank', 'devpw'],
      ['sqlserver', 11433, 'sa', undefined, 'Strong_pw1'],
      ['redis', 6379, undefined, undefined, 'cachepw'],
    ]);
  });

  it('knows which files to read', () => {
    expect(fileKind('.env.local')).toBe('env');
    expect(fileKind('appsettings.json')).toBe('appsettings');
    expect(fileKind('compose.dev.yaml')).toBe('compose');
    expect(fileKind('package.json')).toBeNull();
    expect(detectInFile('.env', 'broken=\n')).toEqual([]);
  });
});

describe('ImportScanner', () => {
  it('scans a project, keeps secrets in the host and finds SQLite files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-scan-'));
    await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://app:pw@localhost:5432/bank\n');
    await writeFile(join(root, '.env.local'), 'DATABASE_URL=postgres://app:pw@localhost:5432/bank\n');
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x', '.env'), 'DATABASE_URL=postgres://no:no@x/y\n');
    await mkdir(join(root, 'data'));
    const db = new DatabaseSync(join(root, 'data', 'app.db'));
    db.exec('CREATE TABLE t (a)');
    db.close();
    await writeFile(join(root, 'data', 'fake.db'), 'not sqlite');
    const scanner = new ImportScanner();
    const found = await scanner.scan(root);
    expect(found.map((c) => [c.engine, c.file, c.hasSecret, c.reference?.variable, c.path])).toEqual([
      ['postgresql', '.env', true, 'DATABASE_URL', undefined],
      ['sqlite', 'data/app.db', false, undefined, 'data/app.db'],
    ]);
    expect(JSON.stringify(found)).not.toContain('pw@');
    expect(scanner.secretFor(root, found[0]!.token)).toBe('pw');
    expect(scanner.secretFor('/elsewhere', found[0]!.token)).toBeNull();
  });
});
