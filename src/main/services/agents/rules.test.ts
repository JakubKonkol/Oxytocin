import { describe, expect, it } from 'vitest';
import { classifyTerminal } from './rules';

const p = (pid: number, name: string, commandLine = name) => ({ pid, ppid: 1, name, commandLine });

describe('classifyTerminal', () => {
  it('returns shell without descendants', () => {
    expect(classifyTerminal([])).toEqual({ kind: 'shell' });
  });

  it('detects agents by process name (Windows .exe included)', () => {
    const c = classifyTerminal([p(10, 'claude.exe')]);
    expect(c).toMatchObject({ kind: 'agent', rule: { id: 'claude-code' }, proc: { pid: 10 } });
  });

  it('detects node-based agents by command line', () => {
    const c = classifyTerminal([p(10, 'node.exe', 'node C:\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js')]);
    expect(c).toMatchObject({ kind: 'agent', rule: { id: 'claude-code' } });
    expect(classifyTerminal([p(11, 'node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js')])).toMatchObject({
      rule: { id: 'codex' },
    });
    expect(classifyTerminal([p(12, 'python3', 'python3 -m aider --model x')])).toMatchObject({ rule: { id: 'aider' } });
  });

  it('prefers the nearest agent and falls back to process', () => {
    const c = classifyTerminal([p(10, 'npm', 'npm run dev'), p(11, 'node', 'node vite')]);
    expect(c).toMatchObject({ kind: 'process', foreground: { pid: 10 } });
    const nested = classifyTerminal([p(20, 'bash'), p(21, 'gemini')]);
    expect(nested).toMatchObject({ kind: 'agent', rule: { id: 'gemini-cli' }, foreground: { pid: 20 } });
  });
});
