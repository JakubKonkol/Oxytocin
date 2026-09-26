import { execFile } from 'node:child_process';

export interface PidRow {
  pid: number;
  ppid: number;
}

/** All descendants of `root` (breadth-first, excluding root). */
export function collectDescendants(root: number, rows: readonly PidRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const out: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export function parsePsPidRows(stdout: string): PidRow[] {
  const rows: PidRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(err.message, { cause: err }));
      else resolve(stdout);
    });
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills a process and all of its descendants (Windows: taskkill /T /F; POSIX: SIGKILL, children first). */
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    await run('taskkill', ['/T', '/F', '/PID', String(pid)]).catch(() => undefined);
    return;
  }
  let descendants: number[] = [];
  try {
    descendants = collectDescendants(pid, parsePsPidRows(await run('ps', ['-A', '-o', 'pid=,ppid='])));
  } catch {
    // ps unavailable — fall back to the root process only.
  }
  for (const target of [...descendants.reverse(), pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
