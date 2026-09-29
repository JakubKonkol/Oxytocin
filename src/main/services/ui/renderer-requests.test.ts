import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '@shared/domain/confirm';
import { RendererRequests } from './renderer-requests';

type Answer = { confirmed: boolean; checked: boolean };

describe('RendererRequests', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the request and resolves with the answer of that request', async () => {
    const sent: ConfirmRequest[] = [];
    const requests = new RendererRequests<ConfirmRequest, Answer>((r) => (sent.push(r), true));
    const answer = requests.ask({ title: 'Quit Oxytocin?', details: ['node in ‘api’'] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Quit Oxytocin?', details: ['node in ‘api’'] });
    expect(sent[0]!.requestId).toMatch(/\S/);
    requests.settle('someone-else', { confirmed: true, checked: false });
    expect(requests.size).toBe(1);
    requests.settle(sent[0]!.requestId, { confirmed: true, checked: true });
    await expect(answer).resolves.toEqual({ confirmed: true, checked: true });
    expect(requests.size).toBe(0);
  });

  it('resolves null without a window, when the renderer goes away or after the timeout', async () => {
    await expect(new RendererRequests<ConfirmRequest, Answer>(() => false).ask({ title: 'x' })).resolves.toBeNull();
    const requests = new RendererRequests<ConfirmRequest, Answer>(() => true);
    const answer = requests.ask({ title: 'x' });
    requests.cancelAll();
    await expect(answer).resolves.toBeNull();

    vi.useFakeTimers();
    const timed = new RendererRequests<ConfirmRequest, Answer>(() => true, 1000);
    const late = timed.ask({ title: 'x' });
    vi.advanceTimersByTime(1000);
    await expect(late).resolves.toBeNull();
    expect(timed.size).toBe(0);
  });
});
