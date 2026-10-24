import { describe, expect, it } from 'vitest';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { sha256 } from '../store/writer';
import { serializeGraph } from './serialize';

describe('graph serialization in slices', () => {
  it('is byte-identical to a single JSON.stringify and hashes the same text', async () => {
    const graph = {
      format: 'oxytocin.code-map',
      schemaVersion: 1,
      generator: { oxytocin: 't', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
      groups: [],
      files: Array.from({ length: 4500 }, (_, index) => ({ id: `f:${index}.ts`, path: `${index}.ts`, note: 'u"\\' })),
      packages: [{ id: 'p:x', name: 'x', external: true }],
      symbols: [],
      edges: Array.from({ length: 2000 }, (_, index) => ({ from: `a${index}`, to: 'b', rel: 'calls', at: [index, 0] })),
      unresolved: [],
      coverage: emptyCodeMapCoverage(),
    } as unknown as CodeMapGraph;
    const { text, hash } = await serializeGraph(graph);
    expect(text).toBe(`${JSON.stringify(graph)}\n`);
    expect(hash).toBe(sha256(text));
  });
});
