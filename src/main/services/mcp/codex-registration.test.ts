import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  codexConfigPath,
  codexHome,
  codexServerToml,
  connectCodex,
  disconnectCodex,
  headerPath,
  isConnectedToCodex,
  nodeCodexFs,
  withCodexServer,
} from './codex-registration';

const BLOCK = codexServerToml(47287, 'tok');

describe('Codex registration', () => {
  it('finds Codex home in CODEX_HOME or ~/.codex', () => {
    expect(codexHome({}, 'linux', '/home/a')).toBe('/home/a/.codex');
    expect(codexHome({ CODEX_HOME: '/opt/codex' }, 'linux', '/home/a')).toBe('/opt/codex');
    expect(codexHome({ codex_home: 'D:\\codex' }, 'win32', 'C:\\Users\\a')).toBe('D:\\codex');
    expect(codexHome({}, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\.codex');
    expect(codexConfigPath('C:\\Users\\a\\.codex', 'win32')).toBe('C:\\Users\\a\\.codex\\config.toml');
  });

  it('writes an HTTP server with the token, the terminal header and a long tool timeout', () => {
    expect(parse(BLOCK)).toEqual({
      mcp_servers: {
        oxytocin: {
          url: 'http://127.0.0.1:47287/mcp',
          http_headers: { Authorization: 'Bearer tok' },
          env_http_headers: { 'X-Oxytocin-Terminal': 'OXYTOCIN_TERMINAL_ID' },
          tool_timeout_sec: 600,
        },
      },
    });
  });

  it('reads table headers with bare and quoted keys', () => {
    expect(headerPath('[mcp_servers.oxytocin]')).toEqual(['mcp_servers', 'oxytocin']);
    expect(headerPath('  [ mcp_servers . "oxytocin" ] # note')).toEqual(['mcp_servers', 'oxytocin']);
    expect(headerPath("[[profiles.'a.b']]")).toEqual(['profiles', 'a.b']);
    expect(headerPath('model = "o3"')).toBeNull();
    expect(headerPath('  ["a", "b"],')).toBeNull();
    expect(headerPath('[a]]')).toBeNull();
  });

  it('appends the server and keeps the rest of the file as it is', () => {
    const config = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.figma]\nurl = "https://figma"\n';
    expect(withCodexServer(config, BLOCK)).toBe(`${config}\n${BLOCK}\n`);
    expect(withCodexServer('', BLOCK)).toBe(`${BLOCK}\n`);
  });

  it('replaces an older entry with its sub-tables, wherever it is', () => {
    const config = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.oxytocin]',
      'url = "http://127.0.0.1:1111/mcp"',
      '',
      '[mcp_servers.oxytocin.http_headers]',
      'Authorization = "Bearer old"',
      '',
      '# Figma, for designs',
      '[mcp_servers.figma]',
      'url = "https://figma"',
      '',
    ].join('\n');
    expect(withCodexServer(config, BLOCK)).toBe(
      [
        'model = "gpt-5"',
        '',
        '# Figma, for designs',
        '[mcp_servers.figma]',
        'url = "https://figma"',
        '',
        BLOCK,
        '',
      ].join('\n'),
    );
    expect(withCodexServer(config, null)).toBe(
      ['model = "gpt-5"', '', '# Figma, for designs', '[mcp_servers.figma]', 'url = "https://figma"', ''].join('\n'),
    );
  });

  it('ignores headers inside multi-line strings and keeps CRLF line ends', () => {
    const config = 'instructions = """\n[mcp_servers.oxytocin]\n"""\r\n[tui]\r\nnotifications = true\r\n';
    const crlf = config.replace(/\r?\n/g, '\r\n');
    const out = withCodexServer(crlf, BLOCK);
    expect(out.startsWith(crlf)).toBe(true);
    expect(out).toContain(`\r\n\r\n${BLOCK.split('\n').join('\r\n')}\r\n`);
    expect(withCodexServer(out, null)).toBe(crlf);
  });

  it('connects, reports and disconnects through the config file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oxy-codex-'));
    const path = codexConfigPath(home, process.platform);
    const missing = join(home, 'nope');
    expect(await isConnectedToCodex(nodeCodexFs, missing, join(missing, 'config.toml'), 47287, 'tok')).toBeNull();
    expect(await isConnectedToCodex(nodeCodexFs, home, path, 47287, 'tok')).toBe(false);

    await writeFile(path, 'model = "gpt-5" # mine\n');
    expect((await connectCodex(nodeCodexFs, path, 47287, 'tok')).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(`model = "gpt-5" # mine\n\n${BLOCK}\n`);
    expect(await isConnectedToCodex(nodeCodexFs, home, path, 47287, 'tok')).toBe(true);
    // Another port or a new token: not connected any more; connecting again replaces the entry.
    expect(await isConnectedToCodex(nodeCodexFs, home, path, 47288, 'tok')).toBe(false);
    expect(await isConnectedToCodex(nodeCodexFs, home, path, 47287, 'new')).toBe(false);
    expect((await connectCodex(nodeCodexFs, path, 47288, 'new')).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(`model = "gpt-5" # mine\n\n${codexServerToml(47288, 'new')}\n`);

    expect((await disconnectCodex(nodeCodexFs, path, 47288)).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('model = "gpt-5" # mine\n');
    expect(await isConnectedToCodex(nodeCodexFs, home, path, 47288, 'new')).toBe(false);
  });

  it('never writes over a config it cannot read or change safely', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oxy-codex-'));
    const path = join(home, 'config.toml');
    await writeFile(path, 'model = "gpt-5\n');
    const broken = await connectCodex(nodeCodexFs, path, 47287, 'tok');
    expect(broken).toMatchObject({ ok: false });
    expect(broken.output).toContain('is not valid TOML (line 1)');
    expect(await readFile(path, 'utf8')).toBe('model = "gpt-5\n');

    // Defined inline in [mcp_servers]: a table of its own would clash with it.
    const inline = '[mcp_servers]\noxytocin = { url = "http://127.0.0.1:1/mcp" }\n';
    await writeFile(path, inline);
    const clash = await connectCodex(nodeCodexFs, path, 47287, 'tok');
    expect(clash).toMatchObject({ ok: false });
    expect(clash.output).toContain('in a form Oxytocin cannot change');
    expect(await readFile(path, 'utf8')).toBe(inline);
  });

  it('creates Codex home and its config when they do not exist yet', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'oxy-codex-')), '.codex');
    const path = join(home, 'config.toml');
    expect((await disconnectCodex(nodeCodexFs, path, 47287)).ok).toBe(true);
    expect((await connectCodex(nodeCodexFs, path, 47287, 'tok')).ok).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(`${BLOCK}\n`);
  });
});
