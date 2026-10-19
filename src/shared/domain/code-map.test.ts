import { describe, expect, it } from 'vitest';
import {
  CodeMapGraphSchema,
  CodeMapManifestSchema,
  CodeMapRelativePathSchema,
  CodeMapSettingsSchema,
  CODE_MAP_LIMITS,
  emptyCodeMapCoverage,
} from './code-map';
import { ProjectsFileSchema } from './project';
import { CodeMapHostContracts } from '../rpc/contracts/code-map-host';

describe('Code Map contracts', () => {
  it('keeps old projects disabled and defaults Git protection on', () => {
    expect(CodeMapSettingsSchema.parse({})).toEqual({ enabled: false, excludedPaths: [], ignoreInGit: true });
    const file = ProjectsFileSchema.parse({
      version: 1,
      activeProjectId: null,
      projects: [
        {
          id: 'project',
          name: 'Example',
          rootPath: '/project',
          color: 0,
          pinned: false,
          order: 0,
          createdAt: 0,
          settings: {},
        },
      ],
    });
    expect(file.projects[0]!.settings.codeMap).toBeUndefined();
  });
  it('round-trips the versioned graph and manifest formats', () => {
    const graph = {
      format: 'oxytocin.code-map',
      schemaVersion: 1,
      generator: {
        oxytocin: '0.9.10',
        extractors: { files: 1 },
        grammars: {},
        settingsHash: `sha256:${'0'.repeat(64)}`,
      },
      groups: [{ id: 'd:src', path: 'src', parent: null, files: 1 }],
      files: [
        {
          id: 'f:src/a.ts',
          path: 'src/a.ts',
          group: 'd:src',
          language: 'typescript',
          bytes: 20,
          lines: 1,
          sha256: '0'.repeat(64),
          status: 'ok',
          test: false,
        },
      ],
      packages: [],
      symbols: [
        {
          id: 's:src/a.ts#run',
          file: 'f:src/a.ts',
          kind: 'function',
          name: 'run',
          owner: null,
          exported: true,
          signature: 'run(): void',
          span: [1, 0, 1, 20],
        },
      ],
      edges: [{ from: 'f:src/a.ts', to: 's:src/a.ts#run', rel: 'contains', prov: 'syntax', at: [1, 0] }],
      unresolved: [],
      coverage: emptyCodeMapCoverage(),
    };
    expect(CodeMapGraphSchema.parse(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
    const time = '2026-10-19T12:00:00.000Z';
    const manifest = {
      format: 'oxytocin.code-map.manifest',
      schemaVersion: 1,
      state: 'ready',
      graphSha256: '0'.repeat(64),
      generation: 1,
      builtAt: time,
      lastReconciledAt: time,
      lastFullHashAt: time,
      durationsMs: { enumerate: 1, parse: 2, resolve: 3, write: 4 },
      counts: { files: 1, symbols: 1, edges: 1 },
      limits: CODE_MAP_LIMITS,
      warnings: [],
    };
    expect(CodeMapManifestSchema.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(CodeMapGraphSchema.safeParse({ ...graph, schemaVersion: 2 }).success).toBe(false);
  });
  it.each(['../a', '/a', 'C:/a', 'a\\b', 'a/../b', 'a//b', 'a\0b'])(
    'rejects an escaping or malformed path: %s',
    (path) => {
      expect(CodeMapRelativePathSchema.safeParse(path).success).toBe(false);
    },
  );
  it('rejects malformed requests at each host method boundary', () => {
    for (const contract of Object.values(CodeMapHostContracts))
      expect(contract.params.safeParse({ checkoutId: 5, unexpected: true }).success).toBe(false);
    expect(
      CodeMapHostContracts['checkout:configure'].params.safeParse({ checkoutId: 'id', root: '/repo' }).success,
    ).toBe(false);
  });
});
