import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataBatcher } from './data-batcher';
import { FlowController } from './flow-control';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FlowController', () => {
  const make = () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const onTimeout = vi.fn();
    const fc = new FlowController({
      pause,
      resume,
      onTimeout,
      highWatermark: 100,
      lowWatermark: 10,
      ackTimeoutMs: 1000,
    });
    fc.setAttached(true);
    return { fc, pause, resume, onTimeout };
  };

  it('pauses above the high watermark and resumes below the low watermark', () => {
    const { fc, pause, resume } = make();
    fc.onSent(60);
    fc.onSent(60);
    expect(pause).toHaveBeenCalledOnce();
    fc.onAck(100);
    expect(resume).not.toHaveBeenCalled();
    fc.onAck(15);
    expect(resume).toHaveBeenCalledOnce();
    expect(fc.isPaused).toBe(false);
  });

  it('never pauses without an attached renderer', () => {
    const { fc, pause } = make();
    fc.setAttached(false);
    fc.onSent(10_000);
    expect(pause).not.toHaveBeenCalled();
  });

  it('resumes when the renderer detaches while paused', () => {
    const { fc, resume } = make();
    fc.onSent(200);
    fc.setAttached(false);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('resumes after the ACK timeout', () => {
    const { fc, resume, onTimeout } = make();
    fc.onSent(200);
    vi.advanceTimersByTime(999);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(fc.unacknowledged).toBe(0);
  });

  it('extends the timeout while ACKs keep arriving', () => {
    const { fc, resume } = make();
    fc.onSent(1000);
    vi.advanceTimersByTime(800);
    fc.onAck(100);
    vi.advanceTimersByTime(800);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('DataBatcher', () => {
  it('flushes after the interval', () => {
    const out: string[] = [];
    const b = new DataBatcher((d) => out.push(d), 5, 1000);
    b.push('a');
    b.push('b');
    expect(out).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(out).toEqual(['ab']);
  });

  it('flushes immediately when the size limit is reached', () => {
    const out: string[] = [];
    const b = new DataBatcher((d) => out.push(d), 5, 4);
    b.push('ab');
    b.push('cd');
    expect(out).toEqual(['abcd']);
    vi.advanceTimersByTime(10);
    expect(out).toEqual(['abcd']);
  });

  it('flush() empties the buffer synchronously and ignores empty input', () => {
    const out: string[] = [];
    const b = new DataBatcher((d) => out.push(d));
    b.push('');
    b.flush();
    expect(out).toEqual([]);
    b.push('x');
    b.flush();
    expect(out).toEqual(['x']);
    expect(b.pending).toBe(0);
  });
});
