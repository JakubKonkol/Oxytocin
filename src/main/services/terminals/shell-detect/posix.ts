import { basename } from 'node:path';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { type DetectDeps, envValue, which } from './deps';

const KNOWN_SHELLS = ['bash', 'zsh', 'fish'] as const;

export function parseEtcShells(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'));
}

export async function detectPosixProfiles(deps: DetectDeps): Promise<TerminalProfile[]> {
  const profiles: TerminalProfile[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const name = basename(file);
    if (seen.has(name)) return;
    seen.add(name);
    profiles.push({ id: name, name, kind: 'shell', file, args: ['-l'], icon: 'terminal', source: 'detected' });
  };
  const loginShell = envValue(deps, 'SHELL');
  if (loginShell && (await deps.isFile(loginShell))) add(loginShell);
  const etcShells = parseEtcShells((await deps.readText('/etc/shells')) ?? '');
  for (const shell of KNOWN_SHELLS) {
    const fromEtc = etcShells.find((s) => basename(s) === shell);
    const file = fromEtc && (await deps.isFile(fromEtc)) ? fromEtc : await which(shell, deps);
    if (file) add(file);
  }
  if (profiles.length === 0 && (await deps.isFile('/bin/sh'))) add('/bin/sh');
  return profiles;
}
