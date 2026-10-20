import { expect, it, vi } from 'vitest';
import { buildLearningTools } from './code-map-learning-tools';

it('exposes one read and two writes, rejects forged provenance and supplies the actual Hub session', async () => {
  const learningTool = vi.fn().mockResolvedValue({
    kind: 'propose',
    code: 'OK',
    id: 'l',
    revision: 1,
    memoryRevision: 1,
    review: 'proposed',
    applicability: 'pending',
    duplicate: false,
  });
  const tools = buildLearningTools({ learningTool });
  expect(tools.map((t) => t.definition.annotations?.readOnlyHint)).toEqual([true, false, false]);
  const proposal = tools[1]!;
  const call = {
    caller: { context: { projectId: 'p', agentId: 'untrusted-header' } },
    sessionId: 'authenticated-session',
    signal: new AbortController().signal,
    args: {
      draft: { kind: 'decision', title: 'Protocol', body: 'Keep it.' },
      expectedRevision: 0,
      idempotencyKey: 'once',
    },
  };
  await proposal.run(call);
  expect(learningTool).toHaveBeenCalledWith(
    'p',
    'p',
    expect.objectContaining({ kind: 'propose' }),
    { session: 'authenticated-session', principal: 'hub', role: 'hub' },
    call.signal,
  );
  await expect(proposal.run({ ...call, args: { ...call.args, author: 'user', sessionId: 'spoofed' } })).rejects.toThrow(
    'Invalid learning arguments',
  );
  await expect(
    proposal.run({
      ...call,
      args: { ...call.args, draft: { ...call.args.draft, evidence: [{ path: 'api.ts', hash: 'spoofed' }] } },
    }),
  ).rejects.toThrow('Invalid learning arguments');
  expect(learningTool).toHaveBeenCalledTimes(1);
  learningTool.mockResolvedValue({ kind: 'propose', code: 'OK', secret: 'must-not-leak' });
  expect(JSON.stringify(await proposal.run(call))).not.toContain('must-not-leak');
});
