import { createHash } from 'node:crypto';
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

  it('propagates resize to the process', async () => {
    setup();
    const o = opts([
      '-e',
      "process.stdout.on('resize', () => console.log('size', process.stdout.columns, process.stdout.rows)); console.log('ready'); setInterval(() => {}, 1000)",
    ]);
    manager.spawn(o);
    await waitFor(async () => (await manager.getText(o.id)).includes('ready'));
    manager.resize(o.id, 100, 40);
    await waitFor(async () => (await manager.getText(o.id)).includes('size 100 40'));
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
    const lines = 200_000;
    const script = `const line = 'x'.repeat(95); let i = 0; function w() { while (i < ${lines}) { const ok = process.stdout.write(String(i).padStart(6, '0') + line + '\\n'); i++; if (!ok) { process.stdout.once('drain', w); return; } } } w();`;
    const o = opts(['-e', script], { scrollback: 1000 });
    manager.spawn(o);
    const session = manager.get(o.id)!;
    let received = '';
    let paused = 0;
    const origPause = ptys[0]!.pause.bind(ptys[0]);
    ptys[0]!.pause = () => {
      paused++;
      origPause();
    };
    // A slow renderer: acknowledges in batches with a delay.
    const sub: Subscriber = {
      send(m) {
        if (m.t !== 'data') return;
        received += m.data;
        const n = m.data.length;
        setTimeout(() => session.ack(n), 20);
      },
    };
    session.attach(sub);
    await waitFor(() => exitOf(o.id) !== undefined, 60_000);
    await new Promise((r) => setTimeout(r, 100));
    const expected = Array.from({ length: lines }, (_, i) => `${String(i).padStart(6, '0')}${'x'.repeat(95)}\r\n`).join(
      '',
    );
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(received.length).toBe(expected.length);
    expect(hash(received)).toBe(hash(expected));
    expect(paused).toBeGreaterThan(0);
  }, 60_000);

  it('kills the whole process tree', async () => {
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
