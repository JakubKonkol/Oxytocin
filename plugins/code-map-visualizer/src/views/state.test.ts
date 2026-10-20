import { expect, it } from 'vitest';
import { stablePositions, ViewEpoch } from './state';
it('rejects late requests including the same project after a context switch', () => {
  const gate = new ViewEpoch(),
    a = gate.begin('a'),
    b = gate.begin('b');
  expect(gate.accepts(a, 'a')).toBe(false);
  expect(gate.accepts(b, 'a')).toBe(false);
  gate.invalidate();
  expect(gate.accepts(b, 'b')).toBe(false);
  const c = gate.begin('a');
  expect(gate.accepts(c, 'a')).toBe(true);
});
it('preserves surviving positions and allocates unused slots deterministically', () => {
  const first = stablePositions(['a', 'b'], new Map());
  first.set('b', { x: 800, y: 300 });
  const next = stablePositions(['b', 'c'], first);
  expect(next.get('b')).toEqual({ x: 800, y: 300 });
  expect(next.has('a')).toBe(false);
  expect(next.get('c')).not.toEqual(next.get('b'));
  expect(stablePositions(['b', 'c'], first)).toEqual(next);
});
