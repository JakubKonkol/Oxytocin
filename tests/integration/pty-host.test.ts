import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Terminal } from '@xterm/headless';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import type { PtyToRenderer } from '../../src/shared/rpc/contracts/pty-channel';
import type { SpawnOptions } from '../../src/shared/domain/terminal';
import { TerminalManager } from '../../src/pty-host/terminal-manager';
import type { Subscriber } from '../../src/pty-host/terminal-session';
import { isAlive } from '../../src/pty-host/process-tree';
import { silentLogger } from '../helpers/logger';

const node = process.execPath;
let manager: TerminalManager;
let events: { name: string; payload: unknown }[];
let ptys: IPty[];

function setup(killTimeoutMs = 3000) {
  events = [];
  ptys = [];
  manager = new TerminalManager({
    spawnPty: (file, args, opts) => {
      const p = ptySpawn(file, args, opts);
      ptys.push(p);
      return p;
    },
    emit: (name, payload) => events.push({ name, payload }),
    logger: silentLogger,
    killTimeoutMs,
  });
}

afterEach(async () => {
  await manager.shutdown(500);
});

let nextId = 0;
function opts(args: string[], extra: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    id: `t${++nextId}`,
    file: node,
    args,
    cwd: tmpdir(),
    env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    scrollback: 1000,
    ...extra,
  };
}

const waitFor = async (cond: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const exitOf = (id: string) =>
  events.find((e) => e.name === 'terminal:exit' && (e.payload as { id: string }).id === id)?.payload as
    { exitCode: number } | undefined;

class Collector implements Subscriber {
  messages: PtyToRenderer[] = [];
  send(m: PtyToRenderer) {
    this.messages.push(m);
  }
}

describe('PTY Host terminal sessions', () => {
  // Windows: Ensemble types messages as one line there (whether paste markers survive ConPTY is not guaranteed).
  it.skipIf(process.platform === 'win32')(
    'pastes a long multi-line message as one bracketed paste and submits it with Enter (Ensemble)',
    async () => {
      setup();
      // A raw-mode program like a TUI: bracketed paste on, reports what one paste contained when Enter arrives.
      const program = [
        "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
        "process.stdout.write('\\x1b[?2004hready\\r\\n');",
        "let buf = '';",
        "process.stdin.on('data', (d) => { buf += d; if (buf.endsWith('\\r')) {",
        '  const m = /\\x1b\\[200~([\\s\\S]*)\\x1b\\[201~\\r$/.exec(buf);',
        "  process.stdout.write(m ? 'PASTE ' + m[1].length + ' lines ' + m[1].split('\\n').length + '\\r\\n' : 'BAD ' + buf.length + '\\r\\n');",
        "  buf = ''; } });",
      ].join('\n');
      const o = opts(['-e', program]);
      manager.spawn(o);
      await waitFor(async () => (await manager.getText(o.id)).includes('ready'));
      const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
      const r = await manager.paste(o.id, text, true);
      expect(r.bracketed).toBe(true);
      await waitFor(async () => /PASTE \d+ lines \d+/.test(await manager.getText(o.id)));
      expect(await manager.getText(o.id)).toContain(`PASTE ${text.length} lines 400`);
    },
  );

  it('spawns a process, mirrors its output and reports the exit code', async () => {
    setup();
    const o = opts(['-e', "console.log('hello from pty'); process.exit(3)"]);
    const { pid } = manager.spawn(o);
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => exitOf(o.id) !== undefined);
    expect(exitOf(o.id)?.exitCode).toBe(3);
    expect(await manager.getText(o.id)).toContain('hello from pty');
    expect(manager.list()).toEqual([{ id: o.id, pid, alive: false }]);
  });

  // Windows: covered by the E2E "terminal size follows the window" test (ConPTY reports the new size asynchronously).
  it.skipIf(process.platform === 'win32')('propagates resize to the process', async () => {
    setup();
    // Poll the window size: Windows only emits 'resize' while reading from the console.
    const o = opts([
      '-e',
      "let last = ''; setInterval(() => { const [c, r] = process.stdout.getWindowSize(); const s = 'size ' + c + 'x' + r; if (s !== last) { last = s; console.log(s); } }, 50)",
    ]);
    manager.spawn(o);
    await waitFor(async () => (await manager.getText(o.id)).includes('size 80x24'));
    manager.resize(o.id, 100, 40);
    await waitFor(async () => (await manager.getText(o.id)).includes('size 100x40'));
  });

  it('streams a snapshot followed by data without gaps or duplicates', async () => {
    setup();
    const o = opts([
      '-e',
      "let i = 0; const t = setInterval(() => { console.log('line ' + i++); if (i === 300) { clearInterval(t); } }, 2)",
    ]);
    manager.spawn(o);
    await waitFor(async () => (await manager.getText(o.id)).includes('line 50'));
    const sub = new Collector();
    manager.get(o.id)!.attach(sub);
    await waitFor(async () => (await manager.getText(o.id)).includes('line 299'));
    await new Promise((r) => setTimeout(r, 50));
    const view = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    let lastSeq = -1;
    for (const m of sub.messages) {
      if (m.t === 'snapshot') {
        lastSeq = m.seq;
        await new Promise<void>((r) => view.write(m.data, r));
      } else if (m.t === 'data') {
        expect(m.seq).toBe(lastSeq + 1);
        lastSeq = m.seq;
        await new Promise<void>((r) => view.write(m.data, r));
      }
    }
    expect(sub.messages[0]?.t).toBe('snapshot');
    const text = (t: Terminal) => {
      const b = t.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true));
      return lines.join('\n').trimEnd();
    };
    expect(text(view)).toBe(await manager.getText(o.id));
  });

  it('serializes a snapshot that rebuilds an identical buffer', async () => {
    setup();
    const o = opts([
      '-e',
      "for (let i = 0; i < 100; i++) console.log('\\x1b[3' + (i % 8) + 'mcolor ' + i + '\\x1b[0m'); setInterval(() => {}, 1000)",
    ]);
    manager.spawn(o);
    await waitFor(async () => (await manager.getText(o.id)).includes('color 99'));
    const snap = await manager.serialize(o.id);
    const copy = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((r) => copy.write(snap.data, r));
    const b = copy.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)!.translateToString(true));
    expect(lines.join('\n').trimEnd()).toBe(await manager.getText(o.id));
    expect(snap.data).toContain('\x1b[3');
  });

  it('delivers 20 MB without loss and applies flow control', async () => {
    setup();
    // 60-char lines stay below the 80 columns so no PTY (ConPTY included) has to wrap them.
    const lines = 330_000;
    const script = `const line = 'x'.repeat(54); let i = 0; function w() { while (i < ${lines}) { const ok = process.stdout.write(String(i).padStart(6, '0') + line + '\\n'); i++; if (!ok) { process.stdout.once('drain', w); return; } } } w();`;
    const o = opts(['-e', script], { scrollback: 1000 });
    manager.spawn(o);
    const session = manager.get(o.id)!;
    const chunks: string[] = [];
    let paused = 0;
    const origPause = ptys[0]!.pause.bind(ptys[0]);
    ptys[0]!.pause = () => {
      paused++;
      origPause();
    };
    // A slow renderer: acknowledges with a delay.
    const sub: Subscriber = {
      send(m) {
        if (m.t !== 'data') return;
        chunks.push(m.data);
        const n = m.data.length;
        setTimeout(() => session.ack(n), 20);
      },
    };
    session.attach(sub);
    await waitFor(() => exitOf(o.id) !== undefined, 90_000);
    await new Promise((r) => setTimeout(r, 100));
    const received = chunks.join('');
    expect(received.length).toBeGreaterThanOrEqual(lines * 61);
    // Platforms may add terminal control sequences (ConPTY); every line must still arrive, in order.
    // eslint-disable-next-line no-control-regex
    const plain = received.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
    const found = plain.match(/\d{6}x{54}/g) ?? [];
    expect(found.length).toBe(lines);
    for (let i = 0; i < lines; i += 997) expect(found[i]).toBe(`${String(i).padStart(6, '0')}${'x'.repeat(54)}`);
    expect(found.at(-1)).toBe(`${String(lines - 1).padStart(6, '0')}${'x'.repeat(54)}`);
    // ConPTY paces its own output, so the high watermark is not reached on Windows.
    if (process.platform !== 'win32') expect(paused).toBeGreaterThan(0);
  }, 120_000);

  // Child discovery uses `ps`; Windows uses `taskkill /T` (covered by the E2E quit tests).
  it.skipIf(process.platform === 'win32')('kills the whole process tree', async () => {
    setup(300);
    const o = opts([
      '-e',
      "const { spawn } = require('child_process'); for (let i = 0; i < 2; i++) spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('children started'); setInterval(() => {}, 1000)",
    ]);
    const { pid } = manager.spawn(o);
    await waitFor(async () => (await manager.getText(o.id)).includes('children started'));
    const children = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === pid)
      .map(([p]) => p!);
    expect(children.length).toBe(2);
    manager.kill(o.id, true);
    await waitFor(() => !isAlive(pid) && children.every((c) => !isAlive(c)));
  });
});
