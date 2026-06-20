import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('ctx.task (async completion)', () => {
  it('dispatches once, suspends, then resumes on completeTask with the result', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    let dispatched = 0;
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.task<{ chargeId: string }>('charge', async () => {
        dispatched += 1;
      });
      return charge.chargeId;
    });

    const first = await startRun(engine, 'checkout', {}, 'run1');
    expect(dispatched).toBe(1);
    expect(first.status).toBe('suspended');

    const done = await engine.completeTask('run1', 'charge', { chargeId: 'ch_1' });
    expect(done?.status).toBe('completed');
    expect(done?.output).toBe('ch_1');
    // dispatch is checkpointed — the resume replays it without firing again.
    expect(dispatched).toBe(1);
  });

  it('failTask makes the run fail at the task', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.register('wf', '1', async (ctx) => ctx.task('t', async () => {}));

    await startRun(engine, 'wf', {}, 'run2');
    const res = await engine.failTask('run2', 't', 'declined');
    expect(res?.status).toBe('failed');
    expect(res?.error?.message).toContain('declined');
  });

  it('clears a stale error when a retried run finally completes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let attempts = 0;
    engine.register('flaky', '1', async (ctx) =>
      ctx.step('once', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return 'ok';
      }),
    );
    const failed = await startRun(engine, 'flaky', {}, 'run3');
    expect(failed.status).toBe('failed');
    expect((await store.getRun('run3'))?.error?.message).toContain('transient');

    const ok = await engine.resume('run3'); // replays; step retries and succeeds
    expect(ok.status).toBe('completed');
    expect((await store.getRun('run3'))?.error).toBeFalsy(); // stale error cleared
  });
});
