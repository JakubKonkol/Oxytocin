import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
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

  it('tracks the cursor as visible again after a soft reset (DECSTR)', async () => {
    const m = new HeadlessMirror(80, 24, 100, signals());
    await written(m, '\x1b[?25l\x1b[!p');
    expect(m.serialize()).not.toContain('\x1b[?25l');
    m.dispose();
  });
});

const PROMPT = 'PS C:\\app> ';

/** Rows of the active buffer, trailing spaces trimmed. */
function lines(m: HeadlessMirror): string[] {
  return m
    .getText()
    .split('\n')
    .map((l) => l.trimEnd());
}

/** What a renderer shows after writing a mirror snapshot into a fresh xterm of the same size. */
async function view(m: HeadlessMirror, windowsBuild?: number) {
  const t = new Terminal({
    cols: m.cols,
    rows: m.rows,
    scrollback: 100,
    allowProposedApi: true,
    ...(windowsBuild !== undefined ? { windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuild } } : {}),
  });
  await new Promise<void>((r) => t.write(m.serialize(), r));
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  const result = { lines: out, baseY: b.baseY, cursorX: b.cursorX, cursorY: b.cursorY };
  t.dispose();
  return result;
}

describe('HeadlessMirror.restore', () => {
  it('puts the separator below the restored lines and resets their modes', async () => {
    const m = new HeadlessMirror(40, 8, 100, signals());
    await m.restore(`${PROMPT}ls\r\nfile1\r\n${PROMPT}\x1b[?25l\x1b[?1004h`, 'Session restored', false);
    expect(lines(m)).toEqual([`${PROMPT}ls`, 'file1', PROMPT.trimEnd(), '── Session restored ──']);
    const data = m.serialize();
    expect(data).not.toContain('\x1b[?25l');
    expect(data).not.toContain('?1004h');
    // The new shell writes below the separator.
    await written(m, '$ ');
    expect(lines(m).at(-1)).toBe('$');
    m.dispose();
  });

  it('keeps lines below the saved cursor (an agent input box) above the separator', async () => {
    const m = new HeadlessMirror(40, 8, 100, signals());
    await m.restore('╭──────╮\r\n│ > hi │\r\n╰──────╯\r\n  footer\x1b[3A\x1b[5G', 'Restarted', false);
    expect(lines(m)).toEqual(['╭──────╮', '│ > hi │', '╰──────╯', '  footer', '── Restarted ──']);
    m.dispose();
  });

  it('holds `whenParsed` until the restored buffer is complete', async () => {
    const m = new HeadlessMirror(40, 8, 100, signals());
    const restored = m.restore('old', 'Restarted', false);
    const text = await new Promise<string>((r) => m.whenParsed(() => r(m.getText())));
    await restored;
    expect(text).toContain('── Restarted ──');
    m.dispose();
  });

  describe('with ConPTY (Windows)', () => {
    const build = 22631;
    /** ConPTY's first frame: it assumes an empty screen with the cursor at the top-left. */
    const firstFrame = `\x1b[?25l\x1b[2J\x1b[m\x1b[H${PROMPT}\x1b]0;pwsh\x07\x1b[?25h`;

    it('moves the restored lines into the scrollback so the first frame does not erase them', async () => {
      const m = new HeadlessMirror(40, 6, 100, signals(), { windowsBuild: build });
      await m.restore(`${PROMPT}ls\r\nfile1\r\n${PROMPT}`, 'Session restored', true);
      await written(m, firstFrame);
      expect(lines(m)).toEqual([`${PROMPT}ls`, 'file1', PROMPT.trimEnd(), '── Session restored ──', PROMPT.trimEnd()]);
      // The renderer rebuilt from the snapshot shows the same, with the cursor after the new prompt.
      const v = await view(m, build);
      expect(v.lines.map((l) => l.trimEnd()).filter(Boolean)).toEqual(lines(m).filter(Boolean));
      expect(v.baseY + v.cursorY).toBe(4);
      expect(v.cursorX).toBe(PROMPT.length);
      m.dispose();
    });

    it('does not pull the scrollback into a growing viewport (like the renderer)', async () => {
      const m = new HeadlessMirror(40, 4, 100, signals(), { windowsBuild: build });
      await written(m, `${PROMPT}\r\n`.repeat(5) + PROMPT);
      m.resize(40, 8);
      // ConPTY repaints its viewport after the resize.
      await written(m, `\x1b[?25l\x1b[H${`${PROMPT}\x1b[K\r\n`.repeat(3)}${PROMPT}\x1b[K\x1b[?25h`);
      const v = await view(m, build);
      // No stale prompt lines below the cursor: they would show up again after a restore.
      expect(v.lines.slice(v.baseY + v.cursorY + 1).every((l) => l.trim() === '')).toBe(true);
      expect(lines(m).filter((l) => l).length).toBe(6);
      m.dispose();
    });
  });
});
