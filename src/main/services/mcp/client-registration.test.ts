import { describe, expect, it } from 'vitest';
import {
  addArgs,
  addCommandLine,
  cliEnv,
  connectClaude,
  isConnectedToClaude,
  mcpConfigJson,
  quoteWin,
  type RunCli,
} from './client-registration';

/** A fake `claude` CLI that knows some registered servers. */
function fakeCli(servers: Record<string, string>) {
  const calls: string[][] = [];
  const run: RunCli = (args) => Promise.resolve(answer(args));
  function answer(args: string[]) {
    calls.push(args);
    const [, cmd, ...rest] = args;
    const name = rest.at(-1)!;
    if (cmd === 'get')
      return servers[name]
        ? { ok: true, output: servers[name] }
        : { ok: false, output: `No MCP server found with name: ${name}` };
    if (cmd === 'remove') {
      const had = name in servers;
      delete servers[name];
      return { ok: had, output: '' };
    }
    servers[args[6]!] = args[7]!;
    return { ok: true, output: 'Added' };
  }
  return { run, calls, servers };
}

describe('client registration', () => {
  it('registers the server in user scope with the token and the terminal header', () => {
    expect(addArgs(47287, 'tok')).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'oxytocin',
      'http://127.0.0.1:47287/mcp',
      '--header',
      'Authorization: Bearer tok',
      '--header',
      'X-Oxytocin-Terminal: ${OXYTOCIN_TERMINAL_ID:-none}',
    ]);
    expect(addCommandLine(47287, 'tok')).toBe(
      "claude mcp add --scope user --transport http oxytocin http://127.0.0.1:47287/mcp --header 'Authorization: Bearer tok' --header 'X-Oxytocin-Terminal: ${OXYTOCIN_TERMINAL_ID:-none}'",
    );
    expect(JSON.parse(mcpConfigJson(1, 't'))).toEqual({
      mcpServers: { oxytocin: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } } },
    });
  });

  it('removes the old oxytocin-runner server when connecting', async () => {
    const cli = fakeCli({ 'oxytocin-runner': 'http://127.0.0.1:47286/mcp' });
    const r = await connectClaude(cli.run, 47287, 'tok');
    expect(r).toMatchObject({ ok: true, migrated: true });
    expect(Object.keys(cli.servers)).toEqual(['oxytocin']);
    expect(await isConnectedToClaude(cli.run, 47287)).toBe(true);
    expect(await isConnectedToClaude(cli.run, 1)).toBe(false);
    const again = await connectClaude(cli.run, 47287, 'tok');
    expect(again.migrated).toBe(false);
  });

  it('cannot tell without Claude Code', async () => {
    const run: RunCli = () => Promise.resolve({ ok: false, output: 'claude was not found.' });
    expect(await isConnectedToClaude(run, 1)).toBeNull();
    expect((await connectClaude(run, 1, 't')).ok).toBe(false);
  });

  it('runs the CLI without a parent Claude Code session and with its install folders on PATH', () => {
    const env = cliEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/usr/bin', HOME: '/home/u' }, 'linux');
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(env['PATH']).toMatch(/^\/usr\/bin:.*\.local\/bin/);
    expect(cliEnv({ Path: 'C:\\x' }, 'win32')['Path']).toMatch(/^C:\\x;/);
    expect(quoteWin('X-Oxytocin-Terminal: ${A:-none}')).toBe('"X-Oxytocin-Terminal: ${A:-none}"');
    expect(quoteWin('plain')).toBe('plain');
  });
});
