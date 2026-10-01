import { exec } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { nodeDetectDeps, which } from '../terminals/shell-detect/deps';

/** The executable of a command line (`claude`, `"C:\Program Files\x\claude.exe" --flag`, `node cli.js`). */
export function executableOf(command: string): string {
  const trimmed = command.trim();
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(trimmed);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  return trimmed.split(/\s+/)[0] ?? '';
}

/** Whether a CLI command can run (PATH lookup) and its `--version`. */
export async function detectCommand(
  command: string,
  env: () => NodeJS.ProcessEnv,
): Promise<{ installed: boolean; version?: string; problem?: string }> {
  const exe = executableOf(command);
  if (!exe) return { installed: false, problem: 'No command' };
  const deps = nodeDetectDeps(env);
  const found = isAbsolute(exe) ? ((await deps.isFile(exe)) ? exe : null) : await which(exe, deps);
  if (!found) return { installed: false, problem: `${exe} was not found on PATH` };
  const version = await new Promise<string | undefined>((resolve) => {
    exec(`${command} --version`, { timeout: 15_000, windowsHide: true, env: env() }, (error, stdout, stderr) => {
      if (error) return resolve(undefined);
      const line = `${stdout}${stderr}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      resolve(line?.slice(0, 80));
    });
  });
  return { installed: true, ...(version ? { version } : {}) };
}
