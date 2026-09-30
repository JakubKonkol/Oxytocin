import { afterEach, describe, expect, it } from 'vitest';
import type { HookInput } from './events';
import { BridgeServer } from './server';

let server: BridgeServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function start(onEvent: (id: string, input: HookInput) => unknown) {
  server = new BridgeServer('secret', onEvent, () => 1234);
  // Port 0 is not what the bridge uses, but lets the test pick a free port; read it back from the address.
  await server.start(0);
  return server;
}

describe('BridgeServer', () => {
  it('sends a JSON hook output when the handler returns one', async () => {
    const s = await start(() => ({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'brief' },
    }));
    const port = (s as unknown as { server: { address(): { port: number } } }).server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/claude/hook`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'X-Oxytocin-Terminal': 't1' },
      body: '{"hook_event_name":"UserPromptSubmit","session_id":"s"}',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'brief' },
    });
  });

  it('accepts authenticated hook posts and attributes them to the terminal', async () => {
    const events: [string, HookInput][] = [];
    const s = await start((id, input) => events.push([id, input]));
    const port = (s as unknown as { server: { address(): { port: number } } }).server.address().port;
    const post = (headers: Record<string, string>, body = '{"hook_event_name":"Stop","session_id":"x"}') =>
      fetch(`http://127.0.0.1:${port}/claude/hook`, { method: 'POST', headers, body });
    const ok = await post({ Authorization: 'Bearer secret', 'X-Oxytocin-Terminal': 't1' });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    expect(events).toEqual([['t1', { hook_event_name: 'Stop', session_id: 'x' }]]);
    expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401);
    // Claude Code outside Oxytocin: the variables are empty.
    expect((await post({ Authorization: 'Bearer ', 'X-Oxytocin-Terminal': '' })).status).toBe(401);
    expect((await post({ Authorization: 'Bearer secret' }, 'not json')).status).toBe(400);
    expect((await post({ Authorization: 'Bearer secret' }, 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    expect(s.stats).toMatchObject({ events: 1, rejected: 5, lastEventAt: 1234 });
  });

  it('reports a port that is in use', async () => {
    const first = await start(() => undefined);
    const port = (first as unknown as { server: { address(): { port: number } } }).server.address().port;
    const second = new BridgeServer('secret', () => undefined);
    await expect(second.start(port)).rejects.toThrow();
    expect(second.stats.error).toMatch(/in use/);
  });
});
