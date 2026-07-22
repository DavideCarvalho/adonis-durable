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

    // And the durable retry timer is a harmless no-op now (B already woken and holding its own
    // signal wait — no due wakeAt remains for the poller to act on).
    now += 60_000;
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A', 'C', 'B']);
  });

  it('a gated run survives a NO-OP runDispatcher: release leaves it DUE for the timer poller', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    // Poll-only deployment (a documented mode): `start` only enqueues; every pickup belongs to the
    // worker loop. The notify-on-release dispatch is a no-op here — so if release CLEARED the gated
    // run's wakeAt (the old behavior), nothing would ever pick it up again: suspended, no wake time,
    // invisible to runPending/recoverIncomplete/resumeDueTimers, forever. Observed in production.
    const engine = new WorkflowEngine({
      store,
      clock: () => now,
      runDispatcher: { dispatch: () => {} },
    });
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        const { id } = input as { id: string };
        if (id === 'A') await ctx.waitForSignal('go:A'); // A holds the slot
        return `done:${id}`;
      },
      { singleton: { key: () => 'k' } },
    );

    await engine.start('job', { id: 'A' }, 'a');
    await engine.runPending(now);
    expect((await store.getRun('a'))?.status).toBe('suspended'); // holding its signal wait

    await engine.start('job', { id: 'B' }, 'b');
    now += 10;
    await engine.runPending(now);
    expect((await store.getRun('b'))?.status).toBe('suspended'); // gated behind A

    // A settles → wakeNext fires. The dispatcher is a no-op, so the ONLY road back for B is a due
    // wakeAt. The post-settle wake is fire-and-forget — poll until it lands (never drain(): that
    // marks the engine as shutting down and resumeDueTimers would refuse to lease).
    await engine.signal('go:A', undefined);
    for (let i = 0; i < 100 && (await store.getRun('b'))?.wakeAt === undefined; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect((await store.getRun('a'))?.status).toBe('completed');

    const gated = await store.getRun('b');
    expect(gated?.status).toBe('suspended');
    expect(gated?.wakeAt).not.toBeUndefined();
    expect(gated!.wakeAt!).toBeLessThanOrEqual(now);

    // The next worker tick's timer phase picks B up and it completes — no dispatcher involved.
    const resumed = await engine.resumeDueTimers(now);
    expect(resumed.map((r) => r.runId)).toContain('b');
    expect((await store.getRun('b'))?.status).toBe('completed');
    expect((await store.getRun('b'))?.output).toBe('done:B');
  });
});
