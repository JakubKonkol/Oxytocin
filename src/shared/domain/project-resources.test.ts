import { describe, expect, it } from 'vitest';
import {
  applyManagedBlock,
  apiSecretKeys,
  buildAgentBrief,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  ProjectResourcesSchema,
  sharedConfigOf,
  validateResources,
} from './project-resources';

describe('managed block', () => {
  it('appends, replaces and removes the block, keeping the rest of the file', () => {
    const added = applyManagedBlock('# Agents\n\nBe nice.\n', 'Brief v1');
    expect(added).toBe(
      `# Agents\n\nBe nice.\n\n${MANAGED_BLOCK_START}\n<!-- Written by Oxytocin (Project settings → Agents). Edits inside this block are replaced. -->\nBrief v1\n${MANAGED_BLOCK_END}\n`,
    );
    const replaced = applyManagedBlock(`${added}More text\n`, 'Brief v2');
    expect(replaced).toContain('Brief v2');
    expect(replaced).not.toContain('Brief v1');
    expect(replaced.endsWith('More text\n')).toBe(true);
    expect(applyManagedBlock(replaced, '')).toBe('# Agents\n\nBe nice.\nMore text\n');
    expect(applyManagedBlock('', 'x')).toContain(MANAGED_BLOCK_START);
    expect(applyManagedBlock('a\r\nb\r\n', 'x')).toContain(`\r\n${MANAGED_BLOCK_START}\r\n`);
  });
});

describe('resources', () => {
  const r = ProjectResourcesSchema.parse({
    databases: [
      {
        id: 'd1',
        name: 'dev-db',
        engine: 'postgresql',
        connection: { kind: 'fields', host: 'localhost', options: {} },
      },
      {
        id: 'd2',
        name: 'prod-db',
        engine: 'postgresql',
        environment: 'production',
        connection: { kind: 'fields', host: 'db.prod', options: {} },
      },
    ],
    apis: [
      { id: 'a1', name: 'api', baseUrl: 'http://localhost:5000', auth: { type: 'headers', names: ['X-A', 'X-B'] } },
      { id: 'a2', name: 'prod-api', baseUrl: 'https://api.prod', environment: 'production' },
    ],
  });

  it('validates names, URLs and production rules', () => {
    expect(validateResources(r)).toEqual([]);
    const bad = ProjectResourcesSchema.parse({
      ...r,
      databases: [...r.databases, { ...r.databases[0]!, id: 'd3' }],
      apis: [
        { ...r.apis[1]!, access: { methods: ['GET', 'DELETE'] } },
        { ...r.apis[0]!, id: 'a3', name: 'x', baseUrl: 'ftp://x' },
      ],
    });
    const problems = validateResources(bad).join('\n');
    expect(problems).toContain('Two resources are named "dev-db"');
    expect(problems).toContain('prod-api: on production, DELETE must ask first.');
    expect(problems).toContain('x: the base URL must be an http(s) address');
  });

  it('shares no production resources and no secrets through the repository', () => {
    const shared = JSON.stringify(sharedConfigOf(r));
    expect(shared).toContain('dev-db');
    expect(shared).not.toContain('db.prod');
    expect(shared).not.toContain('api.prod');
    expect(apiSecretKeys(r.apis[0]!)).toEqual(['header:X-A', 'header:X-B']);
  });

  it('writes a brief that tells agents to use the tools', () => {
    expect(buildAgentBrief('bank', [])).toBe('');
    const brief = buildAgentBrief('bank', [
      { kind: 'api', name: 'api', url: 'http://localhost:5000', environment: 'dev', methods: ['GET'] },
    ]);
    expect(brief).toContain(
      '- API "api" (http://localhost:5000, dev, methods: GET) — use oxy_api_describe / oxy_api_request',
    );
    expect(brief).toContain('instead of looking for credentials');
  });
});
