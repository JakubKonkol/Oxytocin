import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingsService } from './keybindings-service';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-kb-'));
  file = join(dir, 'keybindings.json');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('KeybindingsService', () => {
  it('loads JSONC, skips invalid entries with problems and keeps the last valid state on syntax errors', async () => {
    await writeFile(
      file,
      `// mine
      [
        { "key": "Ctrl+Alt+T", "command": "terminal.new" }, // trailing comment
        { "command": "-panel.close" },
        { "command": "terminal.clear" },
        { "key": "F6", "command": "diff.nextChange", "when": "bogusFocus" },
      ]`,
    );
    const s = new KeybindingsService(file, logger);
    const state = await s.load();
    expect(state.entries).toEqual([{ key: 'Ctrl+Alt+T', command: 'terminal.new' }, { command: '-panel.close' }]);
    expect(state.problems.map((p) => p.index)).toEqual([2, 3]);
    expect(state.problems[1]!.message).toContain('Unknown context "bogusFocus"');

    await writeFile(file, '[ { "key": "F1", ');
    const broken = await s.load();
    expect(broken.entries).toHaveLength(2);
    expect(broken.problems[0]).toMatchObject({ index: -1 });
    expect(broken.problems[0]!.message).toMatch(/Syntax error .* line 1/);
  });

  it('a missing file means no overrides; ensureFile writes a commented template', async () => {
    const s = new KeybindingsService(file, logger);
    expect((await s.load()).entries).toEqual([]);
    await s.ensureFile();
    expect(await readFile(file, 'utf8')).toContain('// Keyboard shortcuts');
    expect((await s.load()).problems).toEqual([]);
  });

  it('replaces the entries of one command and keeps comments and other entries', async () => {
    await writeFile(
      file,
      `[
  // keep me
  { "key": "Ctrl+Alt+T", "command": "terminal.new" },
  { "key": "Ctrl+Alt+K", "command": "terminal.clear" },
  { "command": "-terminal.new" }
]
`,
    );
    const s = new KeybindingsService(file, logger);
    await s.load();
    const changed = vi.fn();
    s.onDidChange(changed);
    const state = await s.setForCommand('terminal.new', [
      { key: 'Ctrl+Alt+N', command: 'terminal.new', when: 'global' },
    ]);
    expect(state.entries).toEqual([
      { key: 'Ctrl+Alt+K', command: 'terminal.clear' },
      { key: 'Ctrl+Alt+N', command: 'terminal.new', when: 'global' },
    ]);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('// keep me');
    expect(changed).toHaveBeenCalledTimes(1);

    const reset = await s.setForCommand('terminal.clear', []);
    expect(reset.entries.map((e) => e.command)).toEqual(['terminal.new']);

    await writeFile(file, '[ oops');
    await expect(s.setForCommand('x', [])).rejects.toThrow(/has errors/);
  });

  it('creates the file on the first change', async () => {
    const s = new KeybindingsService(file, logger);
    const state = await s.setForCommand('panel.close', [{ command: '-panel.close' }]);
    expect(state.entries).toEqual([{ command: '-panel.close' }]);
    expect(await readFile(file, 'utf8')).toContain('// Keyboard shortcuts');
  });
});
