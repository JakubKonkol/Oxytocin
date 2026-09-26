import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRegistry, mapRegistryStatus, parseRegistryEntry } from './claude-registry';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-claude-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Claude session registry', () => {
  it('maps statuses', () => {
    expect(mapRegistryStatus('busy')).toBe('working');
    expect(mapRegistryStatus('shell')).toBe('working');
    expect(mapRegistryStatus('idle')).toBe('idle');
    expect(mapRegistryStatus('waiting')).toBe('waiting');
    expect(mapRegistryStatus('dreaming')).toBe('unknown');
  });

  it('parses entries tolerantly (extra fields kept out, missing fields allowed)', () => {
    // Real 2.1.283 entry shape observed in spike S5 (values redacted).
    const real = {
      pid: 162,
      sessionId: 'abc',
      cwd: '/x',
      startedAt: 1,
      procStart: '539',
      version: '2.1.283',
      peerProtocol: 1,
      kind: 'interactive',
      entrypoint: 'remote',
      name: 'n',
      status: 'busy',
      updatedAt: 2,
      statusUpdatedAt: 2,
    };
    expect(parseRegistryEntry(real)).toEqual({ pid: 162, sessionId: 'abc', cwd: '/x', name: 'n', status: 'busy' });
    expect(parseRegistryEntry({ pid: 1 })).toEqual({ pid: 1 });
    expect(parseRegistryEntry({ nope: true })).toBeNull();
  });

  it('reads <pid>.json files and ignores other files', async () => {
    await writeFile(join(dir, '42.json'), JSON.stringify({ pid: 42, status: 'waiting', waitingFor: 'permission' }));
    await writeFile(join(dir, '42.abc.key'), 'secret');
    await writeFile(join(dir, '43.json'), '{ partial');
    const registry = new ClaudeRegistry({ dir, logger });
    await registry.rescan();
    expect(registry.get(42)).toEqual({ pid: 42, status: 'waiting', waitingFor: 'permission' });
    expect(registry.get(43)).toBeUndefined();
    registry.dispose();
  });

  it('falls back to the CLI when the directory is missing and Claude agents run', async () => {
    const cli = vi.fn(() => Promise.resolve([{ pid: 7, status: 'idle', sessionId: 's' }]));
    const registry = new ClaudeRegistry({ dir: join(dir, 'missing'), logger, cliFallback: cli });
    await registry.rescan();
    expect(cli).not.toHaveBeenCalled();
    registry.hasClaudeAgents = true;
    await registry.rescan();
    expect(registry.get(7)).toEqual({ pid: 7, status: 'idle', sessionId: 's' });
    registry.dispose();
  });
});
