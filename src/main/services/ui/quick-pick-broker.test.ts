import { describe, expect, it, vi } from 'vitest';
import type { QuickPickRequest } from '@shared/domain/quick-pick';
import { QuickPickBroker } from './quick-pick-broker';

describe('QuickPickBroker', () => {
  it('sends a request and resolves with the renderer answer', async () => {
    const sent: QuickPickRequest[] = [];
    const broker = new QuickPickBroker((r) => (sent.push(r), true));
    const result = broker.show([{ label: 'a' }, { label: 'b' }], { placeholder: 'Pick', source: 'Plugin' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ items: [{ label: 'a' }, { label: 'b' }], placeholder: 'Pick', source: 'Plugin' });
    broker.settle('unknown', 0);
    broker.settle(sent[0]!.requestId, 1);
    await expect(result).resolves.toBe(1);
    expect(broker.size).toBe(0);
  });

  it('resolves null without a window, on dismissal and when the renderer goes away', async () => {
    await expect(new QuickPickBroker(() => false).show([{ label: 'a' }])).resolves.toBeNull();
    const send = vi.fn(() => true);
    const broker = new QuickPickBroker(send);
    const a = broker.show([{ label: 'a' }]);
    const b = broker.show([{ label: 'b' }]);
    broker.cancelAll();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
  });
});
