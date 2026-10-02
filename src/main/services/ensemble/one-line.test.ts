import { describe, expect, it } from 'vitest';
import { oneLine } from './ensemble-service';

describe('oneLine', () => {
  it('keeps the structure of a multi-line message on one line', () => {
    expect(oneLine('[Ensemble] New assignment\n\n## The brief\n\nAdd CSV.\n\n\n\nDone  ')).toBe(
      '[Ensemble] New assignment ↵ ↵ ## The brief ↵ ↵ Add CSV. ↵ ↵ Done',
    );
    expect(oneLine('one line')).toBe('one line');
    expect(oneLine('a\nb')).not.toContain('\n');
  });
});
