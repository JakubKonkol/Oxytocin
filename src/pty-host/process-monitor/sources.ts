import { execFile } from 'node:child_process';
import type { ProcInfo } from '@shared/domain/terminal';

export type ProcRow = ProcInfo;

export interface ProcessSource {
  /** All processes; `roots` (terminal shell pids) lets a source limit expensive per-process queries. */
  list(roots: readonly number[]): Promise<ProcRow[]>;
}

/** Pids of all descendants of `roots`. */
export function descendantPids(roots: readonly number[], rows: readonly { pid: number; ppid: number }[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

function run(file: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(err.message, { cause: err }));
      else resolve(stdout);
    });
  });
}

/** Parses `ps -A -o pid=,ppid=,comm=` output (comm may contain spaces on macOS: it is the full path). */
export function parsePsComm(stdout: string): Map<number, { ppid: number; comm: string }> {
  const out = new Map<number, { ppid: number; comm: string }>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]! });
  }
  return out;
}

/** Parses `ps -A -o pid=,args=` output. */
export function parsePsArgs(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!);
  }
  return out;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** macOS / Linux: two `ps` calls per cycle (names and full command lines). */
export function posixSource(): ProcessSource {
  return {
    async list() {
      const [comm, args] = await Promise.all([
        run('ps', ['-A', '-o', 'pid=,ppid=,comm=']),
        run('ps', ['-A', '-o', 'pid=,args=']),
      ]);
      const names = parsePsComm(comm);
      const lines = parsePsArgs(args);
      return [...names].map(([pid, { ppid, comm: c }]) => ({
        pid,
        ppid,
        name: baseName(c),
        commandLine: lines.get(pid) ?? c,
      }));
    },
  };
}

/** Interpreters whose command line decides which tool they run (node cli.js → Claude Code, …). */
const INTERPRETERS = /^(node|nodejs|bun|deno|python\d*(\.\d+)?|pythonw|py|uv|ruby)(\.exe)?$/i;

/** Parses PowerShell `ConvertTo-Json` output of Win32_Process (single object or array). */
export function parseCimCommandLines(json: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!json.trim()) return out;
  const parsed: unknown = JSON.parse(json);
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const rec = item as { ProcessId?: number; CommandLine?: string | null };
    if (typeof rec.ProcessId === 'number') out.set(rec.ProcessId, rec.CommandLine ?? '');
  }
  return out;
}

/**
 * Windows: `ps-list` (bundled fastlist.exe) for pid/ppid/name every cycle; command lines are fetched through
 * CIM only for interpreter processes inside terminals and cached per pid (a command line never changes).
 */
export function windowsSource(): ProcessSource {
  const commandLines = new Map<number, string>();
  return {
    async list(roots) {
      const { default: psList } = await import('ps-list');
      const rows = await psList({ all: true });
      const alive = new Set(rows.map((r) => r.pid));
      for (const pid of commandLines.keys()) if (!alive.has(pid)) commandLines.delete(pid);
      const inTerminals = descendantPids(roots, rows);
      const missing = rows
        .filter((r) => inTerminals.has(r.pid) && INTERPRETERS.test(r.name) && !commandLines.has(r.pid))
        .map((r) => r.pid);
      if (missing.length > 0) {
        const filter = missing
          .slice(0, 64)
          .map((pid) => `ProcessId=${pid}`)
          .join(' OR ');
        try {
          const json = await run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
            ],
            8000,
          );
          for (const [pid, line] of parseCimCommandLines(json)) commandLines.set(pid, line);
        } catch {
          for (const pid of missing) commandLines.set(pid, '');
        }
      }
      return rows.map((r) => ({
        pid: r.pid,
        ppid: r.ppid,
        name: r.name,
        commandLine: commandLines.get(r.pid) || r.name,
      }));
    },
  };
}
