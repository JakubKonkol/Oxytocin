import { describe, expect, it } from 'vitest';
import { commandLine, quoteArg } from './shell-command';

const args = [
  '--model',
  'opus[1m]',
  '--name',
  'ens:csv-export/Ada',
  '--append-system-prompt-file',
  "C:\\Users\\O'Brien\\App Data\\ada.prompt.md",
  '--allowedTools',
  'mcp__oxytocin-ensemble',
  '-c',
  'mcp_servers.x.url=http://127.0.0.1:47287/mcp/ensemble',
];

describe('commandLine', () => {
  it('quotes for PowerShell', () => {
    expect(commandLine('claude', args, 'pwsh')).toMatchInlineSnapshot(
      `"claude --model 'opus[1m]' --name ens:csv-export/Ada --append-system-prompt-file 'C:\\Users\\O''Brien\\App Data\\ada.prompt.md' --allowedTools mcp__oxytocin-ensemble -c mcp_servers.x.url=http://127.0.0.1:47287/mcp/ensemble"`,
    );
    expect(commandLine('"C:\\Program Files\\claude.exe"', ['-v'], 'powershell')).toBe(
      '& "C:\\Program Files\\claude.exe" -v',
    );
  });

  it('quotes for cmd', () => {
    expect(commandLine('claude', args, 'cmd')).toMatchInlineSnapshot(
      `"claude --model "opus[1m]" --name ens:csv-export/Ada --append-system-prompt-file "C:\\Users\\O'Brien\\App Data\\ada.prompt.md" --allowedTools mcp__oxytocin-ensemble -c mcp_servers.x.url=http://127.0.0.1:47287/mcp/ensemble"`,
    );
  });

  it('quotes for bash, zsh and Git Bash', () => {
    expect(commandLine('claude', args, 'bash')).toMatchInlineSnapshot(
      `"claude --model 'opus[1m]' --name ens:csv-export/Ada --append-system-prompt-file 'C:\\Users\\O'\\''Brien\\App Data\\ada.prompt.md' --allowedTools mcp__oxytocin-ensemble -c mcp_servers.x.url=http://127.0.0.1:47287/mcp/ensemble"`,
    );
    expect(commandLine('claude', ['a b'], 'git-bash')).toBe("claude 'a b'");
  });

  it('quotes for fish and converts Windows paths for WSL', () => {
    expect(quoteArg("it's \\ here", 'fish')).toBe("'it\\'s \\\\ here'");
    expect(quoteArg('C:\\Users\\me\\a b.md', 'wsl')).toBe("'/mnt/c/Users/me/a b.md'");
  });

  it('never leaves an empty argument unquoted', () => {
    for (const shell of ['pwsh', 'cmd', 'bash', 'fish'] as const) expect(quoteArg('', shell)).not.toBe('');
  });
});
