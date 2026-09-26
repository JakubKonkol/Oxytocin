import { describe, expect, it, vi } from 'vitest';
import { DisposableStore, toDisposable } from './disposable';

describe('toDisposable', () => {
  it('runs the callback only once', () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    d.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('DisposableStore', () => {
  it('disposes items in reverse order', () => {
    const order: number[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push(1)));
    store.add(toDisposable(() => order.push(2)));
    store.dispose();
    expect(order).toEqual([2, 1]);
    expect(store.isDisposed).toBe(true);
  });

  it('immediately disposes items added after disposal', () => {
    const store = new DisposableStore();
    store.dispose();
    const fn = vi.fn();
    store.add(toDisposable(fn));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('disposes every item even when one throws', () => {
    const store = new DisposableStore();
    const fn = vi.fn();
    store.add(toDisposable(fn));
    store.add(
      toDisposable(() => {
        throw new Error('boom');
      }),
    );
    expect(() => store.dispose()).toThrow('boom');
    expect(fn).toHaveBeenCalledOnce();
  });
});
