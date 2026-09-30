import { describe, expect, it } from 'vitest';
import {
  engineFromHint,
  parseAdoNet,
  parseConnectionString,
  parseJdbc,
  parseKeyValue,
  parseUrl,
} from './connection-strings';

describe('parseUrl', () => {
  it('parses database URLs', () => {
    expect(parseUrl('postgres://bob:p%40ss@db.local:5433/bank?sslmode=require')).toEqual({
      engine: 'postgresql',
      host: 'db.local',
      port: 5433,
      database: 'bank',
      user: 'bob',
      password: 'p@ss',
      options: { sslmode: 'require' },
      tls: { mode: 'require' },
    });
    expect(parseUrl('mysql://root@localhost/shop')).toMatchObject({ engine: 'mysql', host: 'localhost', user: 'root' });
    expect(parseUrl('mysql://root@localhost/shop', 'mariadb')?.engine).toBe('mariadb');
    expect(parseUrl('mongodb+srv://u:p@cluster0.x.mongodb.net/app')).toMatchObject({
      engine: 'mongodb',
      keepAsUrl: true,
      password: 'p',
    });
    expect(parseUrl('rediss://:secret@cache:6380/2')).toMatchObject({
      engine: 'redis',
      password: 'secret',
      options: { db: '2' },
      tls: { mode: 'require' },
    });
    expect(parseUrl('sqlite:./data/app.db')).toEqual({ engine: 'sqlite', path: './data/app.db', options: {} });
    expect(parseUrl('file:dev.db')).toEqual({ engine: 'sqlite', path: 'dev.db', options: {} });
    expect(parseUrl('https://example.com')).toBeNull();
    expect(parseUrl('http://ch:8123/default', 'clickhouse')?.engine).toBe('clickhouse');
    expect(parseUrl('postgres://[::1]:5432/x')?.host).toBe('::1');
  });
});

describe('parseAdoNet', () => {
  it('parses SQL Server strings with instances, ports and trust settings', () => {
    expect(
      parseAdoNet('Server=tcp:.\\SQLEXPRESS,1433;Database=Bank;User Id=sa;Password="a;b";TrustServerCertificate=True'),
    ).toEqual({
      engine: 'sqlserver',
      host: 'localhost',
      port: 1433,
      database: 'Bank',
      user: 'sa',
      password: 'a;b',
      options: { instanceName: 'SQLEXPRESS' },
      tls: { trustServerCertificate: true },
    });
    expect(parseAdoNet('Data Source=(local);Initial Catalog=x;Integrated Security=true')).toMatchObject({
      engine: 'sqlserver',
      host: 'localhost',
      database: 'x',
      options: { integratedSecurity: 'true' },
    });
  });

  it('recognises Npgsql and MySQL', () => {
    expect(parseAdoNet('Host=localhost;Port=5432;Database=bank;Username=app;Password=pw;SSL Mode=Require')).toEqual({
      engine: 'postgresql',
      host: 'localhost',
      port: 5432,
      database: 'bank',
      user: 'app',
      password: 'pw',
      options: {},
      tls: { mode: 'require' },
    });
    expect(parseAdoNet('Server=db;Database=shop;Uid=root;Pwd=pw')).toMatchObject({ engine: 'mysql', user: 'root' });
    expect(parseAdoNet('Data Source=app.db')).toEqual({ engine: 'sqlite', path: 'app.db', options: {} });
  });

  it('parseKeyValue handles quotes and doubled quotes', () => {
    expect([...parseKeyValue("A=1; B='x;''y'; C=\"z\"")]).toEqual([
      ['a', '1'],
      ['b', "x;'y"],
      ['c', 'z'],
    ]);
  });
});

describe('parseJdbc', () => {
  it('parses the common drivers', () => {
    expect(parseJdbc('jdbc:postgresql://localhost:5432/bank?user=app&password=pw')).toMatchObject({
      engine: 'postgresql',
      user: 'app',
      password: 'pw',
      database: 'bank',
      options: {},
    });
    expect(
      parseJdbc(
        'jdbc:sqlserver://db\\SQLEXPRESS:1433;databaseName=Bank;user=sa;password=pw;encrypt=true;trustServerCertificate=true',
      ),
    ).toMatchObject({
      engine: 'sqlserver',
      host: 'db',
      port: 1433,
      database: 'Bank',
      password: 'pw',
      options: { instanceName: 'SQLEXPRESS' },
      tls: { mode: 'require', trustServerCertificate: true },
    });
    expect(parseJdbc('jdbc:mariadb://db:3306/shop')?.engine).toBe('mariadb');
    expect(parseJdbc('jdbc:oracle:thin:@//db:1521/FREEPDB1')).toMatchObject({ engine: 'oracle', database: 'FREEPDB1' });
    expect(parseJdbc('jdbc:oracle:thin:@db:1521:XE')).toMatchObject({ database: 'XE', options: { sid: 'true' } });
  });
});

describe('parseConnectionString', () => {
  it('dispatches by form', () => {
    expect(parseConnectionString('jdbc:mysql://x/y')?.engine).toBe('mysql');
    expect(parseConnectionString('Server=x;Database=y')?.engine).toBe('sqlserver');
    expect(parseConnectionString('hello')).toBeNull();
  });

  it('engineFromHint guesses from names', () => {
    expect(engineFromHint('PG_URL')).toBe('postgresql');
    expect(engineFromHint('MONGODB_URI')).toBe('mongodb');
    expect(engineFromHint('ConnectionStrings.SqlServer')).toBe('sqlserver');
    expect(engineFromHint('DATABASE_URL')).toBeUndefined();
  });
});
