import { describe, expect, it } from 'vitest';
import { displayCommandLine } from './command-line';

describe('displayCommandLine', () => {
  it.each([
    ['"C:\\hostedtoolcache\\windows\\node\\24.21.0\\x64\\node.exe" -e "x"', 'node -e "x"'],
    ['C:\\Windows\\System32\\cmd.EXE /c dir', 'cmd /c dir'],
    ['/usr/bin/python3 app.py --port 1', 'python3 app.py --port 1'],
    ['npm run dev', 'npm run dev'],
    ['node', 'node'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(displayCommandLine(input)).toBe(expected);
  });
});
