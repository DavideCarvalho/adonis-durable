import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowEngine } from './engine.js';
import { remoteStep } from './remote-step-factory.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';
import { InMemoryTransport } from './testing/in-memory-transport.js';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe('durable remote step — retry with backoff', () => {
  it('re-dispatches a failed durable step up to `retries`, spacing attempts by the backoff', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return { ok: true };
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    const flaky = remoteStep({
      name: 'ext.flaky',
      group: 'ext',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      retries: 3,
      backoffMs: 100,
    });
    engine.register('wf', '1', async (ctx) => (await ctx.call(flaky, {})).ok);

    await engine.start('wf', {}, 'r1');
    await flush(); // attempt 1 fails → checkpoint failed, run suspended awaiting the backoff
    expect(attempts).toBe(1);
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    nowMs = 1100;
    await engine.resumeDueTimers(nowMs);
    await flush(); // attempt 2 fails → suspended again
    expect(attempts).toBe(2);
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    nowMs = 1200;
    await engine.resumeDueTimers(nowMs);
    await flush(); // attempt 3 succeeds
    expect(attempts).toBe(3);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
  });

  it('does not retry when the worker marks the error non-retryable', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    transport.handle('ext.declined', async () => {
      attempts += 1;
      const err = Object.assign(new Error('declined'), { retryable: false });
      throw err;
    });
    const engine = new WorkflowEngine({ store, transport });
    const declined = remoteStep({
      name: 'ext.declined',
      group: 'ext',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      retries: 5,
    });
    engine.register('wf', '1', async (ctx) => ctx.call(declined, {}));

    await engine.start('wf', {}, 'r1');
    await flush();
    expect(attempts).toBe(1); // no retry despite retries: 5
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });
});
