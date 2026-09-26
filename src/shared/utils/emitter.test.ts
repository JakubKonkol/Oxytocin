import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter';

describe('Emitter', () => {
  it('delivers values to subscribed listeners until they unsubscribe', () => {
    const emitter = new Emitter<number>();
    const listener = vi.fn();
    const sub = emitter.event(listener);
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(1);
    expect(emitter.hasListeners).toBe(false);
  });

  it('allows the same function to subscribe twice independently', () => {
    const emitter = new Emitter<string>();
    const listener = vi.fn();
    const a = emitter.event(listener);
    emitter.event(listener);
    a.dispose();
    emitter.fire('x');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
