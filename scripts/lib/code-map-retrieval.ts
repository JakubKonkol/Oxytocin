import { z } from 'zod';

/** Frozen retrieval questions with ground-truth files decided before any ranking run. */
export const RetrievalCorpusSchema = z
  .object({
    format: z.literal('oxytocin.code-map.retrieval-corpus'),
    version: z.number().int().positive(),
    revision: z.string().min(7),
    notes: z.string(),
    questions: z
      .array(
        z
          .object({
            id: z.string().regex(/^q\d+$/),
            split: z.enum(['train', 'heldout']),
            question: z.string().min(1).max(2000),
            expected: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((corpus) => new Set(corpus.questions.map((q) => q.id)).size === corpus.questions.length, 'Duplicate IDs');
export type RetrievalCorpus = z.infer<typeof RetrievalCorpusSchema>;

export interface RetrievalRow {
  id: string;
  split: 'train' | 'heldout';
  question: string;
  /** 1-based position of the first expected file among distinct result files; 0 when absent. */
  rank: number;
  /** Characters of the compact agent-facing answer. */
  chars: number;
  files: string[];
}

/** Distinct files in result order. */
export function distinctFiles(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function rankOf(files: readonly string[], expected: readonly string[]): number {
  return files.findIndex((file) => expected.includes(file)) + 1;
}

export interface RetrievalSummary {
  questions: number;
  hit1: number;
  hit3: number;
  hit8: number;
  /** Mean reciprocal rank, 0 for misses. */
  mrr: number;
  meanChars: number;
}

export function summarize(rows: readonly RetrievalRow[]): RetrievalSummary {
  const n = rows.length;
  const count = (limit: number) => rows.filter((row) => row.rank > 0 && row.rank <= limit).length;
  return {
    questions: n,
    hit1: count(1),
    hit3: count(3),
    hit8: count(8),
    mrr: n ? Number((rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n).toFixed(3)) : 0,
    meanChars: n ? Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / n) : 0,
  };
}
