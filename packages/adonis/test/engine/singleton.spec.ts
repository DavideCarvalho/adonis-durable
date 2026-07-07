import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('singleton (serialize runs by key)', () => {
  it('admits an uncontended singleton run immediately and emits run.started', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const started: string[] = [];
    engine.subscribe((e) => {
      if (e.type === 'run.started') started.push(e.runId);
    });
    engine.register('job', '1', async () => 'done', { singleton: { key: () => 'k' } });

    // No timer drives: a lone singleton run must run straight to completion, not get force-suspended
    // on admission, and it must still announce run.started.
    const r = await startRun(engine, 'job', {}, 'solo');
    expect(r.status).toBe('completed');
    expect(started).toEqual(['solo']);
  });

  it('runs one at a time per key; the next admits when the first completes', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const ran: string[] = [];

    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        const { id } = input as { id: string };
        await ctx.localStep('enter', async () => void ran.push(id)); // once-only (checkpointed)
        await ctx.waitForSignal(`go:${id}`); // hold the slot until signalled
        return 'done';
      },
      { singleton: { key: (input) => (input as { key: string }).key } },
    );

    // A admits immediately (the slot is free), enters, then holds the slot on its signal wait.
    await startRun(engine, 'job', { id: 'A', key: 'k' }, 'a');
    // B shares the key → the slot is taken, so it gates (suspended) on the retry timer.
    await startRun(engine, 'job', { id: 'B', key: 'k' }, 'b');
    expect(ran).toEqual(['A']);
    expect((await store.getRun('b'))?.status).toBe('suspended');

    // Different key → its own slot, runs immediately.
    await startRun(engine, 'job', { id: 'C', key: 'other' }, 'c');
    expect(ran).toEqual(['A', 'C']);

    await engine.signal('go:A', undefined); // A completes → frees the slot
    expect((await store.getRun('a'))?.status).toBe('completed');

    // Notify-on-release: completing A wakes the next gated waiter (B) IMMEDIATELY — no timer tick
    // needed. Poll until B's `enter` runs (the wake is dispatched asynchronously).
    for (let i = 0; i < 100 && !ran.includes('B'); i++) await new Promise((r) => setTimeout(r, 2));
    expect(ran).toEqual(['A', 'C', 'B']);

    // And the durable retry timer is a harmless no-op now (B already woken; its wakeAt was cleared).
    now += 60_000;
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A', 'C', 'B']);
  });
});
