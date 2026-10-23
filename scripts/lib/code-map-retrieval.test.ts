import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { distinctFiles, rankOf, RetrievalCorpusSchema, summarize, type RetrievalRow } from './code-map-retrieval';

const root = join(import.meta.dirname, '..', '..');

it('ranks the first expected file among distinct result files', () => {
  const files = distinctFiles(['a.ts', 'a.ts', 'b.ts', 'c.ts']);
  expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(rankOf(files, ['c.ts', 'b.ts'])).toBe(2);
  expect(rankOf(files, ['z.ts'])).toBe(0);
});

it('summarizes hit rates, reciprocal rank and answer size', () => {
  const row = (rank: number, chars: number): RetrievalRow => ({
    id: 'q01',
    split: 'train',
    question: 'q',
    rank,
    chars,
    files: [],
  });
  expect(summarize([row(1, 100), row(3, 200), row(0, 300), row(6, 400)])).toEqual({
    questions: 4,
    hit1: 1,
    hit3: 2,
    hit8: 3,
    mrr: Number(((1 + 1 / 3 + 1 / 6) / 4).toFixed(3)),
    meanChars: 250,
  });
  expect(summarize([]).mrr).toBe(0);
});

it('keeps the frozen corpus valid and its expected files present', () => {
  const corpus = RetrievalCorpusSchema.parse(
    JSON.parse(readFileSync(join(root, 'scripts/fixtures/code-map-retrieval/corpus.json'), 'utf8')),
  );
  expect(corpus.questions.filter((q) => q.split === 'heldout').length).toBeGreaterThanOrEqual(20);
  for (const question of corpus.questions)
    for (const path of question.expected) expect(existsSync(join(root, path)), path).toBe(true);
});
