import { describe, expect, it, vi } from 'vitest';
import { PtyPortLink } from './pty-port-link';

describe('PtyPortLink', () => {
  it('connects when the shell loads while the host runs, and on host (re)starts after the shell loaded', () => {
    let running = false;
    const connect = vi.fn();
    const link = new PtyPortLink(() => running, connect);
    link.hostDidBecomeReady();
    expect(connect).not.toHaveBeenCalled();
    link.shellDidLoad();
    expect(connect).not.toHaveBeenCalled();
    // The host becomes ready later, e.g. while plugin iframes are still loading: the port is still sent.
    running = true;
    link.hostDidBecomeReady();
    expect(connect).toHaveBeenCalledTimes(1);
    link.hostDidBecomeReady();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('waits for the next load after a reload started', () => {
    const connect = vi.fn();
    const link = new PtyPortLink(() => true, connect);
    link.shellDidLoad();
    link.shellDidUnload();
    expect(link.loaded).toBe(false);
    link.hostDidBecomeReady();
    expect(connect).toHaveBeenCalledTimes(1);
    link.shellDidLoad();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
