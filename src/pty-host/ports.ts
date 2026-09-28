import { execFile } from 'node:child_process';
import { descendantPids } from './process-monitor/sources';
import { parsePsPidRows, type PidRow } from './process-tree';

/** A listening TCP socket and the process that owns it. */
export interface ListeningSocket {
  pid: number;
  port: number;
}

/** Runs a tool; `lenient` resolves its output even for a non-zero exit (lsof exits with 1 when nothing listens). */
function run(file: string, args: string[], lenient = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !(lenient && typeof (err as { code?: unknown }).code === 'number'))
        reject(new Error(err.message, { cause: err }));
      else resolve(stdout);
    });
  });
}

/** Port of a local address: `*:5173`, `0.0.0.0:3000`, `[::1]:8080`, `127.0.0.1%lo:80`. */
function portOf(address: string): number | null {
  const m = /:(\d{1,5})$/.exec(address.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? port : null;
}

/**
 * Windows `netstat -ano` (IPv4 and IPv6): `TCP  0.0.0.0:5173  0.0.0.0:0  LISTENING  1234`. The state column is
 * translated on localized Windows ("ABHÖREN", "NASŁUCHIWANIE"), so listening sockets are recognised by their foreign
 * address instead: `0.0.0.0:0` / `[::]:0` (connections always have a remote port).
 */
export function parseNetstat(stdout: string): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]?.toUpperCase() !== 'TCP') continue;
    const foreign = cols[2] ?? '';
    const listening = /^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(foreign) || /^LISTEN/i.test(cols[3] ?? '');
    if (!listening) continue;
    const port = portOf(cols[1]!);
    const pid = Number(cols.at(-1));
    if (port !== null && Number.isInteger(pid) && pid > 0) out.push({ pid, port });
  }
  return out;
}

/** macOS/Linux `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: `p1234` then one `n*:5173` line per socket. */
export function parseLsof(stdout: string): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith('n') && pid > 0) {
      const port = portOf(line.slice(1).replace(/->.*$/, ''));
      if (port !== null) out.push({ pid, port });
    }
  }
  return out;
}

/** Linux `ss -ltnpH`: `LISTEN 0 511 *:5173 *:* users:(("node",pid=1234,fd=20),…)`. */
export function parseSs(stdout: string): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const port = portOf(cols[3]!);
    if (port === null) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) out.push({ pid: Number(m[1]), port });
  }
  return out;
}

/** Ports whose owner is `root` or one of its descendants (sorted, unique). */
export function portsOfTree(root: number, rows: readonly PidRow[], sockets: readonly ListeningSocket[]): number[] {
  const tree = descendantPids([root], rows);
  tree.add(root);
  return [...new Set(sockets.filter((s) => tree.has(s.pid)).map((s) => s.port))].sort((a, b) => a - b);
}

async function processRows(platform: NodeJS.Platform): Promise<PidRow[]> {
  if (platform === 'win32') {
    const { default: psList } = await import('ps-list');
    return (await psList({ all: true })).map((r) => ({ pid: r.pid, ppid: r.ppid }));
  }
  return parsePsPidRows(await run('ps', ['-A', '-o', 'pid=,ppid=']));
}

async function listeningSockets(platform: NodeJS.Platform): Promise<ListeningSocket[]> {
  if (platform === 'win32') return parseNetstat(await run('netstat', ['-ano']));
  if (platform === 'linux') {
    try {
      return parseSs(await run('ss', ['-ltnpH']));
    } catch {
      // ss missing (minimal images) — lsof below.
    }
  }
  return parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], true));
}

const SNAPSHOT_TTL_MS = 1500;
let snapshot: { at: number; data: Promise<[PidRow[], ListeningSocket[]]> } | undefined;

/**
 * Processes and listening sockets, shared by the requests of the next 1.5 s: several running apps polling their
 * ports at once cost one `ps`/`netstat` run.
 */
function systemSnapshot(platform: NodeJS.Platform, now = Date.now()): Promise<[PidRow[], ListeningSocket[]]> {
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.data;
  const data = Promise.all([processRows(platform), listeningSockets(platform)]);
  snapshot = { at: now, data };
  // A failed snapshot is not reused.
  data.catch(() => {
    if (snapshot?.data === data) snapshot = undefined;
  });
  return data;
}

/** TCP ports that the process tree of `pid` listens on. */
export async function listeningPortsOf(pid: number, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  const [rows, sockets] = await systemSnapshot(platform);
  return portsOfTree(pid, rows, sockets);
}
