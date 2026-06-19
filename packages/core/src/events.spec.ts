import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('events (waitForEvent / publishEvent)', () => {
  it('fans an event out only to the runs whose match the payload satisfies', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('order', '1', async (ctx, input) => {
      const { orderId } = input as { orderId: string };
      const p = await ctx.waitForEvent<{ amount: number }>('payment.settled', {
        match: { orderId },
      });
      return `paid ${p.amount}`;
    });

    await startRun(engine, 'order', { orderId: 'o1' }, 'r1');
    await startRun(engine, 'order', { orderId: 'o2' }, 'r2');
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    const delivered = await engine.publishEvent('payment.settled', { orderId: 'o1', amount: 99 });
    expect(delivered).toBe(1);
    expect((await store.getRun('r1'))?.output).toBe('paid 99');
    expect((await store.getRun('r2'))?.status).toBe('suspended');

    await engine.publishEvent('payment.settled', { orderId: 'o2', amount: 5 });
    expect((await store.getRun('r2'))?.output).toBe('paid 5');
  });

  it('a no-match waiter receives any event of that name (broadcast)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('listener', '1', async (ctx) => {
      const p = await ctx.waitForEvent<{ v: number }>('tick');
      return p.v;
    });
    await startRun(engine, 'listener', {}, 'a');
    await startRun(engine, 'listener', {}, 'b');

    const n = await engine.publishEvent('tick', { v: 7 });
    expect(n).toBe(2);
    expect((await store.getRun('a'))?.output).toBe(7);
    expect((await store.getRun('b'))?.output).toBe(7);
  });
});
