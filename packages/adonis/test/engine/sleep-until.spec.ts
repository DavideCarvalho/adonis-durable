import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('WorkflowEngine — ctx.sleepUntil (absolute wake time)', () => {
  it('suspends until the given timestamp, then resumes', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now });

    const order: string[] = [];
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('before', async () => void order.push('before'));
      await ctx.sleepUntil(new Date(20_000)); // absolute epoch ms
      await ctx.step('after', async () => void order.push('after'));
      return 'done';
    });

    expect((await startRun(engine, 'wf', {}, 'r1')).status).toBe('suspended');
    expect(order).toEqual(['before']);

    now = 10_000; // before the wake time → still suspended
    await engine.resumeDueTimers(now);
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    now = 21_000; // past the wake time → resumes + completes
    await engine.resumeDueTimers(now);
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(order).toEqual(['before', 'after']);
  });
});
