import { describe, expect, it } from 'vitest';
import { classifyMongo, classifyRedis, decideNoSql } from './nosql-guard';

const mongo = (operation: string, args: Record<string, unknown>, mode: 'read-only' | 'confirm-writes' | 'read-write') =>
  decideNoSql(mode, classifyMongo('users', operation, args), 'db').action;

describe('MongoDB guard', () => {
  it('lets reads through', () => {
    expect(mongo('find', { filter: { age: { $gt: 3 } } }, 'read-only')).toBe('run-read');
    expect(mongo('aggregate', { pipeline: [{ $match: {} }, { $group: { _id: '$a' } }] }, 'read-only')).toBe('run-read');
    expect(mongo('countDocuments', {}, 'read-only')).toBe('run-read');
    expect(mongo('distinct', { field: 'a' }, 'read-only')).toBe('run-read');
  });

  it.each([
    ['$out', { pipeline: [{ $match: {} }, { $out: 'copy' }] }],
    ['$merge', { pipeline: [{ $merge: { into: 'x' } }] }],
    [
      '$function in a nested $lookup',
      {
        pipeline: [
          {
            $lookup: {
              from: 'o',
              pipeline: [{ $addFields: { a: { $function: { body: 'x', args: [], lang: 'js' } } } }],
              as: 'o',
            },
          },
        ],
      },
    ],
    ['$accumulator in $facet', { pipeline: [{ $facet: { a: [{ $group: { _id: 1, x: { $accumulator: {} } } }] } }] }],
    ['$where in $unionWith', { pipeline: [{ $unionWith: { coll: 'b', pipeline: [{ $match: { $where: 'true' } }] } }] }],
  ])('rejects aggregate with %s', (_label, args) => {
    expect(mongo('aggregate', args, 'read-only')).toBe('reject');
  });

  it('rejects $where filters and unknown operations', () => {
    expect(mongo('find', { filter: { $where: 'sleep(1000)' } }, 'read-only')).toBe('reject');
    expect(mongo('drop', {}, 'read-write')).toBe('reject');
    expect(mongo('dropDatabase', {}, 'read-write')).toBe('reject');
    expect(mongo('runCommand', {}, 'read-write')).toBe('reject');
  });

  it('follows the write modes', () => {
    expect(mongo('insertOne', { document: { a: 1 } }, 'read-only')).toBe('reject');
    expect(mongo('insertOne', { document: { a: 1 } }, 'confirm-writes')).toBe('ask');
    expect(mongo('insertOne', { document: { a: 1 } }, 'read-write')).toBe('run-write');
    expect(mongo('deleteMany', { filter: {} }, 'read-write')).toBe('ask');
    expect(mongo('updateMany', { update: { $set: { a: 1 } } }, 'read-write')).toBe('ask');
    expect(mongo('deleteMany', { filter: { a: 1 } }, 'read-write')).toBe('run-write');
  });
});

describe('Redis guard', () => {
  const redis = (command: string, args: string[], mode: 'read-only' | 'read-write' = 'read-only') =>
    decideNoSql(mode, classifyRedis(command, args), 'cache').action;

  it('lets the allowlist through', () => {
    for (const cmd of ['GET', 'mget', 'HGETALL', 'SCAN', 'ZRANGE', 'XRANGE', 'INFO', 'DBSIZE', 'TTL'])
      expect(redis(cmd, ['k'])).toBe('run-read');
    expect(redis('MEMORY', ['USAGE', 'k'])).toBe('run-read');
  });

  it('never offers dangerous commands', () => {
    for (const cmd of ['EVAL', 'FUNCTION', 'CONFIG', 'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'DEBUG', 'MODULE', 'SCRIPT'])
      expect(redis(cmd, [], 'read-write')).toBe('reject');
    expect(classifyRedis('KEYS', ['*']).reasons[0]).toContain('SCAN');
  });

  it('follows the write modes', () => {
    expect(redis('SET', ['k', 'v'])).toBe('reject');
    expect(redis('SET', ['k', 'v'], 'read-write')).toBe('run-write');
    expect(redis('DEL', ['k'], 'read-write')).toBe('ask');
  });
});
