import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '@shared/domain/workspace';
import { restoredScrollbackData, WorkspaceStateService } from './workspace-state-service';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-ws-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const state = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
  version: 1,
  projectId: 'p1',
  savedAt: 1,
  dockview: { grid: {} },
  panels: { 'term-a1': { kind: 'terminal', terminalId: 't-1', profileId: 'bash', cwd: '/tmp' } },
  ui: {},
  ...over,
});

describe('WorkspaceStateService', () => {
  it('saves and loads a workspace', async () => {
    const svc = new WorkspaceStateService(dir, logger);
    await svc.save(state());
    expect((await new WorkspaceStateService(dir, logger).load('p1')).state).toEqual(state());
    expect((await svc.load('missing')).state).toBeNull();
  });

  it('moves an unreadable file aside and reports a problem', async () => {
    await writeFile(join(dir, 'p1.json'), '{ broken');
    const result = await new WorkspaceStateService(dir, logger).load('p1');
    expect(result.state).toBeNull();
    expect(result.problem).toContain('default layout');
    expect((await readdir(dir)).some((f) => f.startsWith('p1.json.corrupt-'))).toBe(true);
  });

  it('rejects unsafe ids', async () => {
    const svc = new WorkspaceStateService(dir, logger);
    await expect(svc.load('../evil')).rejects.toMatchObject({ code: 'INVALID' });
    expect(() => svc.scrollbackPath('p1', '../x')).toThrow();
  });

  it('persists scrollback of live terminals at quit', async () => {
    const svc = new WorkspaceStateService(dir, logger);
    await svc.save(
      state({
        panels: {
          'term-a1': { kind: 'terminal', terminalId: 't-1', profileId: 'bash', cwd: '/tmp' },
          'term-b2': { kind: 'terminal', terminalId: 't-dead', profileId: 'bash', cwd: '/tmp' },
        },
      }),
    );
    await svc.persistScrollback((id) => Promise.resolve(id === 't-1' ? 'hello\r\n' : null));
    const saved = JSON.parse(await readFile(join(dir, 'p1.json'), 'utf8')) as WorkspaceState;
    expect(saved.panels['term-a1']).toMatchObject({ scrollbackFile: 'p1/scrollback/term-a1.vt' });
    expect(saved.panels['term-b2']).not.toHaveProperty('scrollbackFile');
    expect((await svc.readScrollback('p1', 'term-a1'))?.data).toBe('hello\r\n');
  });
});

describe('WorkspaceStateService.persistScrollback', () => {
  it('takes every snapshot before writing any file, and records all of them', async () => {
    const svc = new WorkspaceStateService(dir, logger);
    await svc.save(
      state({
        panels: {
          'term-a1': { kind: 'terminal', terminalId: 't-1', profileId: 'bash', cwd: '/tmp' },
          'term-b2': { kind: 'terminal', terminalId: 't-2', profileId: 'bash', cwd: '/tmp' },
          'term-c3': { kind: 'terminal', terminalId: 't-3', profileId: 'bash', cwd: '/tmp' },
        },
      }),
    );
    const pending = new Map<string, (data: string | null) => void>();
    const done = svc.persistScrollback((id) => new Promise<string | null>((resolve) => pending.set(id, resolve)));
    // All terminals are asked at once (a slow one does not hold up the others).
    await vi.waitFor(() => expect([...pending.keys()].sort()).toEqual(['t-1', 't-2', 't-3']));
    pending.get('t-1')!('one\r\n');
    pending.get('t-2')!('two\r\n');
    pending.get('t-3')!(null);
    await done;
    const saved = JSON.parse(await readFile(join(dir, 'p1.json'), 'utf8')) as WorkspaceState;
    expect(saved.panels['term-a1']).toMatchObject({ scrollbackFile: 'p1/scrollback/term-a1.vt' });
    expect(saved.panels['term-b2']).toMatchObject({ scrollbackFile: 'p1/scrollback/term-b2.vt' });
    expect(saved.panels['term-c3']).not.toHaveProperty('scrollbackFile');
    expect((await svc.readScrollback('p1', 'term-b2'))?.data).toBe('two\r\n');
    expect(await readdir(join(dir, 'p1', 'scrollback'))).toEqual(['term-a1.vt', 'term-b2.vt']);
  });
});

describe('restoredScrollbackData', () => {
  it('appends a mode reset and a dimmed separator', () => {
    const data = restoredScrollbackData('old', new Date(2026, 8, 26, 18, 42));
    expect(data.startsWith('old\x1b[0m\x1b[?25h')).toBe(true);
    // Leaving the alternate screen restores the cursor, so it is only emitted when the snapshot used it.
    expect(restoredScrollbackData('\x1b[?1049h\x1b[Hfull', new Date())).toContain('\x1b[0m\x1b[?1049l');
    expect(data).toContain('── Session restored · Sep 26, 2026, 6:42 PM ──');
  });
});
