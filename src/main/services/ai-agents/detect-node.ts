import { exec } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { nodeDetectDeps, which } from '../terminals/shell-detect/deps';
import type { AiDetectDeps } from './detect';

/** Only loopback servers are asked (local model runtimes). */
const isLoopback = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
};

/** The detection's I/O on this computer, with the resolved login-shell environment. */
export function nodeAiDetectDeps(getEnv: () => NodeJS.ProcessEnv, home = homedir()): AiDetectDeps {
  const shellDeps = nodeDetectDeps(getEnv);
  return {
    platform: process.platform,
    get env() {
      return getEnv();
    },
    home,
    which: (name) => which(name, shellDeps),
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    run(commandLine, timeoutMs) {
      return new Promise((resolve) => {
        // Through the shell: npm installs agents as .cmd shims on Windows. No console window, no stdin.
        const child = exec(
          commandLine,
          {
            timeout: timeoutMs,
            windowsHide: true,
            env: { ...getEnv(), NO_COLOR: '1', CI: '1' },
            maxBuffer: 256 * 1024,
          },
          (error, stdout, stderr) => resolve(error && !stdout ? null : `${stdout}${stderr}`),
        );
        child.stdin?.end();
      });
    },
    async httpJson(url, timeoutMs) {
      if (!isLoopback(url)) return null;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        return (await res.json()) as unknown;
      } catch {
        return null;
      }
    },
  };
}
