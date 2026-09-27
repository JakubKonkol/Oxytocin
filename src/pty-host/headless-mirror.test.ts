import { describe, expect, it, vi } from 'vitest';
import { HeadlessMirror } from './headless-mirror';

const signals = () => ({
  onTitle: vi.fn(),
  onBell: vi.fn(),
  onProgress: vi.fn(),
  onNotification: vi.fn(),
  onCwd: vi.fn(),
  onShellMark: vi.fn(),
});

const written = (m: HeadlessMirror, data: string) => new Promise<void>((r) => m.write(data, r));

describe('HeadlessMirror', () => {
  it('appends cursor visibility and mouse encoding that SerializeAddon drops', async () => {
    const m = new HeadlessMirror(80, 24, 100, signals());
    await written(m, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25lTUI');
    const data = m.serialize();
    expect(data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(true);
    await written(m, '\x1b[?25h\x1b[?1006l');
    const after = m.serialize();
    expect(after).not.toContain('\x1b[?25l');
    expect(after).not.toContain('?1006h');
    m.dispose();
  });

  it('reports OSC signals without consuming them', async () => {
    const s = signals();
    const m = new HeadlessMirror(80, 24, 100, s);
    await written(
      m,
      '\x1b]0;my title\x07\x1b]9;4;3\x07\x1b]9;Done\x07\x1b]777;notify;Claude;Needs input\x07\x1b]7;file://h/tmp/x\x07\x07',
    );
    expect(s.onTitle).toHaveBeenCalledWith('my title');
    expect(s.onProgress).toHaveBeenCalledWith(3, undefined);
    expect(s.onNotification).toHaveBeenCalledWith('Done');
    expect(s.onNotification).toHaveBeenCalledWith('Needs input', 'Claude');
    expect(s.onCwd).toHaveBeenCalledWith('/tmp/x');
    expect(s.onBell).toHaveBeenCalledOnce();
    m.dispose();
  });
});
